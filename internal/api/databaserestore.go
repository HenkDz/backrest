package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/garethgeorge/backrest/internal/auth"
	"github.com/garethgeorge/backrest/internal/orchestrator"
	"github.com/google/uuid"
)

// Recovery credentials and target selection are server-owned, never UI inputs.
type DatabaseRestoreConfig struct {
	SchemaVersion int      `json:"schemaVersion"`
	Environment   string   `json:"environment"`
	RepoID        string   `json:"repoId"`
	RepoGUID      string   `json:"repoGuid"`
	SSHConfig     string   `json:"sshConfig"`
	SSHAlias      string   `json:"sshAlias"`
	Operators     []string `json:"operators"`
}

type recoveryRequest struct {
	Action           string `json:"action"`
	JobID            string `json:"jobId,omitempty"`
	SnapshotID       string `json:"snapshotId,omitempty"`
	Confirmation     string `json:"confirmation,omitempty"`
	Environment      string `json:"environment,omitempty"`
	Actor            string `json:"actor,omitempty"`
	QueuesReconciled bool   `json:"queuesReconciled,omitempty"`
}

type recoveryReply struct {
	Environment string          `json:"environment"`
	Target      string          `json:"target"`
	Job         json.RawMessage `json:"job,omitempty"`
	Error       string          `json:"error,omitempty"`
}

type recoverySnapshot struct {
	ID       string   `json:"id"`
	Time     string   `json:"time"`
	Hostname string   `json:"hostname"`
	Tags     []string `json:"tags"`
	at       time.Time
	search   string
}

type databaseRestoreHandler struct {
	orch           *orchestrator.Orchestrator
	configPath     string
	run            func(context.Context, DatabaseRestoreConfig, recoveryRequest) (recoveryReply, error)
	listSnapshots  func(context.Context, DatabaseRestoreConfig, bool) ([]recoverySnapshot, error)
	mu             sync.Mutex
	snapshotOnce   sync.Once
	snapshotGate   chan struct{}
	snapshotGUID   string
	snapshotLoaded time.Time
	snapshotCache  []recoverySnapshot
}

var recoveryID = regexp.MustCompile(`^[0-9a-f]{32}$`)
var recoverySnapshotID = regexp.MustCompile(`^[0-9a-f]{64}$`)
var recoveryAlias = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func NewDatabaseRestoreHandler(orch *orchestrator.Orchestrator) http.Handler {
	handler := &databaseRestoreHandler{orch: orch, configPath: os.Getenv("BACKREST_DATABASE_RESTORE_CONFIG"), run: runRecoverySSH}
	handler.listSnapshots = handler.snapshots
	return handler
}

func readRecoveryConfig(path string) (DatabaseRestoreConfig, error) {
	var cfg DatabaseRestoreConfig
	if path == "" || !filepath.IsAbs(path) {
		return cfg, errors.New("staging recovery is not configured")
	}
	file, err := os.Open(path)
	if err != nil {
		return cfg, errors.New("staging recovery configuration is unavailable")
	}
	defer file.Close()
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return cfg, errors.New("staging recovery configuration must be a private regular file")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 16385))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&cfg) != nil || decoder.Decode(new(any)) != io.EOF || cfg.SchemaVersion != 1 || cfg.Environment != "staging" || cfg.RepoID != "dzdistro-staging-postgres" || cfg.RepoGUID == "" || !filepath.IsAbs(cfg.SSHConfig) || !recoveryAlias.MatchString(cfg.SSHAlias) || len(cfg.Operators) == 0 {
		return cfg, errors.New("invalid staging recovery configuration")
	}
	for _, operator := range cfg.Operators {
		if operator == "" || len(operator) > 128 {
			return cfg, errors.New("invalid staging recovery operator allowlist")
		}
	}
	return cfg, nil
}

func (h *databaseRestoreHandler) snapshots(ctx context.Context, cfg DatabaseRestoreConfig, fresh bool) ([]recoverySnapshot, error) {
	repo, err := h.orch.GetRepo(cfg.RepoID)
	if err != nil || repo.Guid != cfg.RepoGUID || repo.OriginInstanceId != "" {
		return nil, errors.New("staging repository identity changed")
	}
	return h.cachedSnapshots(ctx, cfg.RepoGUID, fresh, func() ([]recoverySnapshot, error) {
		return h.loadSnapshots(ctx, cfg)
	})
}

func (h *databaseRestoreHandler) cachedSnapshots(ctx context.Context, guid string, fresh bool, load func() ([]recoverySnapshot, error)) ([]recoverySnapshot, error) {
	h.snapshotOnce.Do(func() { h.snapshotGate = make(chan struct{}, 1) })
	select {
	case h.snapshotGate <- struct{}{}:
		defer func() { <-h.snapshotGate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !fresh && h.snapshotGUID == guid && time.Since(h.snapshotLoaded) < time.Minute {
		return h.snapshotCache, nil
	}
	result, err := load()
	if err != nil {
		return nil, err
	}
	h.snapshotCache, h.snapshotGUID, h.snapshotLoaded = result, guid, time.Now()
	return result, nil
}

func (h *databaseRestoreHandler) loadSnapshots(ctx context.Context, cfg DatabaseRestoreConfig) ([]recoverySnapshot, error) {
	runner, err := h.orch.GetRepoOrchestrator(cfg.RepoID)
	if err != nil {
		return nil, errors.New("staging repository is unavailable")
	}
	items, err := runner.Snapshots(ctx)
	if err != nil {
		return nil, errors.New("cannot read encrypted staging snapshots")
	}
	result := []recoverySnapshot{}
	for _, snapshot := range items {
		if !recoverySnapshotID.MatchString(snapshot.Id) {
			continue
		}
		for _, path := range snapshot.Paths {
			if path == "dzdistro_staging.dump" || path == "/dzdistro_staging.dump" {
				at, err := time.Parse(time.RFC3339Nano, snapshot.Time)
				if err != nil {
					continue
				}
				result = append(result, recoverySnapshot{ID: snapshot.Id, Time: snapshot.Time, Hostname: snapshot.Hostname, Tags: snapshot.Tags, at: at, search: strings.ToLower(snapshot.Id + " " + snapshot.Hostname + " " + strings.Join(snapshot.Tags, " "))})
				break
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].at.Equal(result[j].at) {
			return result[i].ID < result[j].ID
		}
		return result[i].at.After(result[j].at)
	})
	return result, nil
}

func recoveryJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (h *databaseRestoreHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(auth.UserContextKey).(interface{ GetName() string })
	if !ok || user.GetName() == "" {
		recoveryJSON(w, 401, map[string]string{"error": "Sign in to use database recovery."})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		recoveryJSON(w, 405, map[string]string{"error": "Method not allowed."})
		return
	}
	if _, err := auth.ParseBearerToken(r.Header.Get("Authorization")); err != nil {
		recoveryJSON(w, 401, map[string]string{"error": "Database recovery requires your signed-in session."})
		return
	}
	cfg, err := readRecoveryConfig(h.configPath)
	if err != nil {
		recoveryJSON(w, 503, map[string]string{"error": err.Error()})
		return
	}
	if !slices.Contains(cfg.Operators, user.GetName()) {
		recoveryJSON(w, 403, map[string]string{"error": "Your account is not authorized for staging database recovery."})
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Get("view") == "snapshots" {
		h.serveSnapshotPage(w, r, cfg)
		return
	}
	request := recoveryRequest{Action: "status", JobID: r.URL.Query().Get("jobId")}
	if r.Method == http.MethodPost {
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			recoveryJSON(w, 415, map[string]string{"error": "Recovery requests must be JSON."})
			return
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.Environment != "" || request.Actor != "" {
			recoveryJSON(w, 400, map[string]string{"error": "Invalid recovery request."})
			return
		}
		switch request.Action {
		case "prepare", "freeze", "restore", "resume", "freeze-rollback", "rollback", "abort":
		default:
			recoveryJSON(w, 400, map[string]string{"error": "Unsupported recovery action."})
			return
		}
	}
	if request.Action == "prepare" {
		if request.JobID != "" || !recoverySnapshotID.MatchString(request.SnapshotID) {
			recoveryJSON(w, 400, map[string]string{"error": "Select a complete snapshot ID."})
			return
		}
		request.JobID = strings.ReplaceAll(uuid.NewString(), "-", "")
	} else if request.JobID != "" && !recoveryID.MatchString(request.JobID) || request.Action != "status" && request.JobID == "" {
		recoveryJSON(w, 400, map[string]string{"error": "Invalid recovery job."})
		return
	}
	if request.Action == "resume" && !request.QueuesReconciled {
		recoveryJSON(w, 400, map[string]string{"error": "Confirm that queued work and cached data were reconciled before resuming."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Minute)
	defer cancel()
	if r.Method == http.MethodPost && !h.mu.TryLock() {
		recoveryJSON(w, 409, map[string]string{"error": "Another recovery request is running. Refresh its status before retrying."})
		return
	}
	if r.Method == http.MethodPost {
		defer h.mu.Unlock()
	}
	if request.Action == "prepare" {
		snapshots, err := h.listSnapshots(ctx, cfg, true)
		if err != nil {
			recoveryJSON(w, 409, map[string]string{"error": err.Error()})
			return
		}
		found := false
		for _, snapshot := range snapshots {
			found = found || snapshot.ID == request.SnapshotID
		}
		if !found {
			recoveryJSON(w, 400, map[string]string{"error": "Snapshot is not in the configured staging repository."})
			return
		}
	}
	request.Environment, request.Actor = "staging", user.GetName()
	reply, err := h.run(ctx, cfg, request)
	if err != nil {
		recoveryJSON(w, 502, map[string]string{"error": "Worker response unavailable. Refresh the job; do not repeat a database switch.", "jobId": request.JobID})
		return
	}
	if reply.Environment != "staging" || reply.Target != "dzdistro-staging" {
		recoveryJSON(w, 502, map[string]string{"error": "Recovery worker identity mismatch."})
		return
	}
	if len(reply.Job) > 0 && string(reply.Job) != "null" {
		var identity struct {
			ID         string `json:"id"`
			SnapshotID string `json:"snapshotId"`
		}
		if json.Unmarshal(reply.Job, &identity) != nil || !recoveryID.MatchString(identity.ID) || !recoverySnapshotID.MatchString(identity.SnapshotID) || request.JobID != "" && identity.ID != request.JobID || request.Action == "prepare" && identity.SnapshotID != request.SnapshotID {
			recoveryJSON(w, 502, map[string]string{"error": "Recovery job identity mismatch."})
			return
		}
	}
	if reply.Error != "" {
		recoveryJSON(w, 409, reply)
		return
	}
	if r.Method == http.MethodPost && (len(reply.Job) == 0 || string(reply.Job) == "null") {
		recoveryJSON(w, 502, map[string]string{"error": "Worker did not confirm a recovery job. Refresh status before retrying."})
		return
	}
	recoveryJSON(w, 200, struct {
		recoveryReply
		RepoID string `json:"repoId"`
	}{reply, cfg.RepoID})
}

func runRecoverySSH(ctx context.Context, cfg DatabaseRestoreConfig, request recoveryRequest) (recoveryReply, error) {
	var result recoveryReply
	input, err := json.Marshal(request)
	if err != nil {
		return result, err
	}
	command := exec.CommandContext(ctx, "ssh", "-F", cfg.SSHConfig, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "IdentitiesOnly=yes", "-o", "RequestTTY=no", "-o", "ConnectTimeout=10", cfg.SSHAlias, "nhws-staging-recovery")
	command.Stdin = bytes.NewReader(append(input, '\n'))
	// The worker returns sanitized JSON on stdout, never raw PostgreSQL/SSH diagnostics.
	output := &boundedRecoveryOutput{}
	command.Stdout = output
	err = command.Run()
	if json.Unmarshal(output.Bytes(), &result) != nil {
		return result, errors.New("invalid worker response")
	}
	if err != nil && result.Error == "" {
		return result, errors.New("worker did not complete")
	}
	return result, nil
}

type boundedRecoveryOutput struct{ bytes.Buffer }

func (output *boundedRecoveryOutput) Write(data []byte) (int, error) {
	if output.Len()+len(data) > 1<<20 {
		return 0, errors.New("worker response too large")
	}
	return output.Buffer.Write(data)
}
