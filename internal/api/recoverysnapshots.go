package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

type snapshotQuery struct {
	search, host, tag, order string
	from, until              time.Time
	page, size               int
	fresh                    bool
}

type snapshotPage struct {
	Snapshots []recoverySnapshot `json:"snapshots"`
	Total     int                `json:"total"`
	Available int                `json:"available"`
	Page      int                `json:"page"`
	PageSize  int                `json:"pageSize"`
	Pages     int                `json:"pages"`
	LatestID  string             `json:"latestId"`
}

func parseSnapshotQuery(values url.Values) (snapshotQuery, error) {
	q := snapshotQuery{search: strings.TrimSpace(values.Get("q")), host: strings.TrimSpace(values.Get("host")), tag: strings.TrimSpace(values.Get("tag")), order: values.Get("order"), page: 1, size: 25, fresh: values.Get("refresh") == "true"}
	invalid := errors.New("Invalid backup filters. Use a valid date range and a page size from 1 to 100.")
	if len(q.search) > 128 || len(q.host) > 128 || len(q.tag) > 128 {
		return q, invalid
	}
	if q.order == "" {
		q.order = "newest"
	}
	if q.order != "newest" && q.order != "oldest" {
		return q, invalid
	}
	for key, target := range map[string]*int{"page": &q.page, "pageSize": &q.size} {
		if raw := values.Get(key); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 || value > 1000000 {
				return q, invalid
			}
			*target = value
		}
	}
	if q.size > 100 {
		return q, invalid
	}
	zone := time.FixedZone("Algiers", 3600)
	for key, target := range map[string]*time.Time{"from": &q.from, "to": &q.until} {
		if raw := values.Get(key); raw != "" {
			date, err := time.ParseInLocation("2006-01-02", raw, zone)
			if err != nil {
				return q, invalid
			}
			*target = date
		}
	}
	if !q.until.IsZero() {
		if !q.from.IsZero() && q.until.Before(q.from) {
			return q, invalid
		}
		q.until = q.until.AddDate(0, 0, 1)
	}
	q.search = strings.ToLower(q.search)
	return q, nil
}

// Catalog is sorted once when loaded; filtering retains only one bounded page.
func filterSnapshotPage(items []recoverySnapshot, q snapshotQuery) snapshotPage {
	result := snapshotPage{Snapshots: make([]recoverySnapshot, 0, q.size), Available: len(items), Page: q.page, PageSize: q.size}
	if len(items) > 0 {
		result.LatestID = items[0].ID
	}
	matches := func(item recoverySnapshot) bool {
		if q.host != "" && item.Hostname != q.host || q.tag != "" && !slices.Contains(item.Tags, q.tag) {
			return false
		}
		at := item.at
		if at.IsZero() {
			at, _ = time.Parse(time.RFC3339Nano, item.Time)
		}
		if !q.from.IsZero() && at.Before(q.from) || !q.until.IsZero() && !at.Before(q.until) {
			return false
		}
		if q.search == "" {
			return true
		}
		search := item.search
		if search == "" {
			search = strings.ToLower(item.ID + " " + item.Hostname + " " + strings.Join(item.Tags, " "))
		}
		return strings.Contains(search, q.search)
	}
	// Count first so a shrinking catalog can clamp a now-empty last page.
	unfiltered := q.search == "" && q.host == "" && q.tag == "" && q.from.IsZero() && q.until.IsZero()
	if unfiltered {
		result.Total = len(items)
	} else {
		for _, item := range items {
			if matches(item) {
				result.Total++
			}
		}
	}
	result.Pages = max(1, (result.Total+q.size-1)/q.size)
	result.Page = min(q.page, result.Pages)
	offset := (result.Page - 1) * q.size
	found := 0
	begin := 0
	if unfiltered {
		begin, found = offset, offset
	}
	for i := begin; i < len(items); i++ {
		index := i
		if q.order == "oldest" {
			index = len(items) - 1 - i
		}
		if !matches(items[index]) {
			continue
		}
		if found >= offset {
			result.Snapshots = append(result.Snapshots, items[index])
		}
		found++
		if len(result.Snapshots) == q.size {
			break
		}
	}
	return result
}

func (h *databaseRestoreHandler) serveSnapshotPage(w http.ResponseWriter, r *http.Request, cfg DatabaseRestoreConfig) {
	query, err := parseSnapshotQuery(r.URL.Query())
	if err != nil {
		recoveryJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	items, err := h.listSnapshots(ctx, cfg, query.fresh)
	if err != nil {
		recoveryJSON(w, 409, map[string]string{"error": err.Error()})
		return
	}
	recoveryJSON(w, 200, filterSnapshotPage(items, query))
}
