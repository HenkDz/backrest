package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/internal/auth"
)

const testRecoverySnapshot = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func recoveryFixture(t *testing.T) (*databaseRestoreHandler, *int) {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "recovery.json")
	cfg := DatabaseRestoreConfig{1, "staging", "dzdistro-staging-postgres", "pinned-guid", filepath.Join(directory, "ssh-config"), "staging-recovery", []string{"operator"}}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	calls := new(int)
	handler := &databaseRestoreHandler{configPath: path,
		listSnapshots: func(context.Context, DatabaseRestoreConfig, bool) ([]recoverySnapshot, error) {
			return []recoverySnapshot{{ID: testRecoverySnapshot, Time: "2026-10-14T01:00:00Z"}}, nil
		},
		run: func(_ context.Context, _ DatabaseRestoreConfig, request recoveryRequest) (recoveryReply, error) {
			*calls++
			if request.Actor != "operator" || request.Environment != "staging" {
				t.Fatal("client supplied recovery authority")
			}
			job, _ := json.Marshal(map[string]string{"id": request.JobID, "snapshotId": testRecoverySnapshot, "phase": "validated"})
			return recoveryReply{Environment: "staging", Target: "dzdistro-staging", Job: job}, nil
		},
	}
	return handler, calls
}

func recoveryHTTP(handler http.Handler, method, body string, signedIn bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/api/database-restore", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if signedIn {
		request.Header.Set("Authorization", "Bearer verified-by-outer-auth-middleware")
		request = request.WithContext(context.WithValue(request.Context(), auth.UserContextKey, &v1.User{Name: "operator"}))
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestDatabaseRecoveryRejectsUntrustedAuthorityBeforeWorker(t *testing.T) {
	for _, body := range []string{
		`{"action":"prepare","snapshotId":"short"}`,
		`{"action":"restore","jobId":"../production","confirmation":"anything"}`,
		`{"action":"restore","jobId":[],"confirmation":"anything"}`,
		`{"action":"prepare","snapshotId":"` + testRecoverySnapshot + `","environment":"production"}`,
		`{"action":"prepare","snapshotId":"` + testRecoverySnapshot + `","actor":"another-admin"}`,
		`{"action":"prepare","snapshotId":"` + testRecoverySnapshot + `","database":"production"}`,
		`{"action":"run-command","jobId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
		`{"action":"prepare","snapshotId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`,
	} {
		handler, calls := recoveryFixture(t)
		response := recoveryHTTP(handler, "POST", body, true)
		if response.Code != 400 || *calls != 0 {
			t.Fatalf("request %s: status=%d worker calls=%d", body, response.Code, *calls)
		}
	}
	handler, calls := recoveryFixture(t)
	response := recoveryHTTP(handler, "POST", `{"action":"prepare","snapshotId":"`+testRecoverySnapshot+`"}`, false)
	if response.Code != 401 || *calls != 0 {
		t.Fatal("unauthenticated request reached worker")
	}
}

func TestDatabaseRecoveryBindsOperatorSnapshotAndServerJob(t *testing.T) {
	handler, calls := recoveryFixture(t)
	response := recoveryHTTP(handler, "POST", `{"action":"prepare","snapshotId":"`+testRecoverySnapshot+`"}`, true)
	if response.Code != 200 || *calls != 1 {
		t.Fatalf("valid request failed: %s", response.Body)
	}
	var result struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}
	if json.Unmarshal(response.Body.Bytes(), &result) != nil || !recoveryID.MatchString(result.Job.ID) {
		t.Fatal("job identity was not server-generated")
	}
}

func TestDatabaseRecoveryFailsClosedOnWorkerIdentityAndLostResponse(t *testing.T) {
	for _, kind := range []string{"wrong-target", "wrong-job", "no-job", "lost-response"} {
		handler, _ := recoveryFixture(t)
		handler.run = func(_ context.Context, _ DatabaseRestoreConfig, request recoveryRequest) (recoveryReply, error) {
			if kind == "lost-response" {
				return recoveryReply{}, errors.New("response lost after possible action")
			}
			job, _ := json.Marshal(map[string]string{"id": strings.Repeat("b", 32), "snapshotId": testRecoverySnapshot})
			reply := recoveryReply{Environment: "staging", Target: "dzdistro-staging", Job: job}
			if kind == "wrong-target" {
				reply.Environment = "production"
			}
			if kind == "no-job" {
				reply.Job = nil
			}
			return reply, nil
		}
		response := recoveryHTTP(handler, "POST", `{"action":"prepare","snapshotId":"`+testRecoverySnapshot+`"}`, true)
		if response.Code != 502 {
			t.Fatalf("%s was not held: %d", kind, response.Code)
		}
	}
}

func TestDatabaseRecoveryDisallowsProductionConfiguration(t *testing.T) {
	handler, calls := recoveryFixture(t)
	data, _ := os.ReadFile(handler.configPath)
	data = []byte(strings.Replace(string(data), `"environment":"staging"`, `"environment":"production"`, 1))
	_ = os.WriteFile(handler.configPath, data, 0600)
	response := recoveryHTTP(handler, "GET", "", true)
	if response.Code != 503 || *calls != 0 {
		t.Fatal("production worker configuration was accepted")
	}
}

func TestDatabaseRecoveryConcurrentMutationRefused(t *testing.T) {
	handler, calls := recoveryFixture(t)
	handler.mu.Lock()
	defer handler.mu.Unlock()
	response := recoveryHTTP(handler, "POST", `{"action":"prepare","snapshotId":"`+testRecoverySnapshot+`"}`, true)
	if response.Code != 409 || *calls != 0 {
		t.Fatal("concurrent recovery reached worker")
	}
}

func TestDatabaseRecoveryUnauthorizedAccountHasNoWorkerAuthority(t *testing.T) {
	handler, calls := recoveryFixture(t)
	data, _ := os.ReadFile(handler.configPath)
	data = []byte(strings.Replace(string(data), `"operators":["operator"]`, `"operators":["different-operator"]`, 1))
	_ = os.WriteFile(handler.configPath, data, 0600)
	response := recoveryHTTP(handler, "POST", `{"action":"prepare","snapshotId":"`+testRecoverySnapshot+`"}`, true)
	if response.Code != 403 || *calls != 0 {
		t.Fatal("unapproved account reached recovery worker")
	}
}
