package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/garethgeorge/backrest/gen/go/v1"
	"github.com/garethgeorge/backrest/internal/auth"
)

func catalogHTTP(h *databaseRestoreHandler, query string, signedIn bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest("GET", "/api/database-restore?view=snapshots&"+query, nil)
	if signedIn {
		request.Header.Set("Authorization", "Bearer outer-middleware-verified")
		request = request.WithContext(context.WithValue(request.Context(), auth.UserContextKey, &v1.User{Name: "operator"}))
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	return response
}

func TestDatabaseRecoverySnapshotPageValidationAndAuthority(t *testing.T) {
	h, calls := recoveryFixture(t)
	listingCalls := 0
	h.listSnapshots = func(context.Context, DatabaseRestoreConfig, bool) ([]recoverySnapshot, error) {
		listingCalls++
		return nil, nil
	}
	for _, query := range []string{"page=0", "pageSize=101", "page=99999999999999", "order=random", "from=2026-02-30", "from=2026-10-14&to=2026-10-13", "q=" + string(make([]byte, 129))} {
		if query[:2] == "q=" {
			query = "q=" + url.QueryEscape(query[2:])
		}
		response := catalogHTTP(h, query, true)
		if response.Code != 400 {
			t.Fatalf("%q accepted: %s", query, response.Body)
		}
	}
	if listingCalls != 0 || *calls != 0 {
		t.Fatal("invalid filters reached repository or worker")
	}
	if response := catalogHTTP(h, "", false); response.Code != 401 {
		t.Fatal("anonymous catalog accepted")
	}
	if listingCalls != 0 {
		t.Fatal("anonymous listing touched repository")
	}
	response := catalogHTTP(h, "", true)
	if response.Code != 200 || listingCalls != 1 || *calls != 0 {
		t.Fatal("catalog should not invoke recovery SSH")
	}
}

func TestDatabaseRecoverySnapshotFiltersBoundariesAndShrinkingPage(t *testing.T) {
	items := []recoverySnapshot{
		{ID: "new", Time: "2026-10-14T23:00:00Z", Hostname: "staging", Tags: []string{"daily"}},
		{ID: "inside", Time: "2026-10-14T22:59:59Z", Hostname: "staging", Tags: []string{"daily", "restore-validation"}},
		{ID: "start", Time: "2026-10-13T23:00:00Z", Hostname: "staging", Tags: []string{"daily"}},
		{ID: "outside", Time: "2026-10-13T22:59:59Z", Hostname: "other", Tags: []string{"weekly"}},
	}
	q, err := parseSnapshotQuery(url.Values{"from": {"2026-10-14"}, "to": {"2026-10-14"}, "host": {"staging"}, "tag": {"daily"}, "pageSize": {"1"}, "page": {"99"}})
	if err != nil {
		t.Fatal(err)
	}
	page := filterSnapshotPage(items, q)
	if page.Total != 2 || page.Page != 2 || page.Pages != 2 || page.Snapshots[0].ID != "start" || page.LatestID != "new" {
		t.Fatalf("incorrect bounds: %+v", page)
	}
	q.order = "oldest"
	q.page = 1
	if filterSnapshotPage(items, q).Snapshots[0].ID != "start" {
		t.Fatal("oldest order failed")
	}
	q.search = "restore-validation"
	if page = filterSnapshotPage(items, q); page.Total != 1 || page.Snapshots[0].ID != "inside" {
		t.Fatal("tag search failed")
	}
	q.tag = "missing"
	if page = filterSnapshotPage(items, q); page.Total != 0 || page.Page != 1 || len(page.Snapshots) != 0 {
		t.Fatal("no-match page failed")
	}
}

func largeRecoveryCatalog() []recoverySnapshot {
	items := make([]recoverySnapshot, 100000)
	for i := range items {
		at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC).Add(-time.Duration(i) * time.Minute)
		items[i] = recoverySnapshot{ID: fmt.Sprintf("%064x", i), Time: at.Format(time.RFC3339Nano), Hostname: "staging", Tags: []string{"daily"}, at: at}
		items[i].search = items[i].ID + " staging daily"
	}
	return items
}

func TestDatabaseRecoveryLargeCatalogBoundedAndFreshPrepare(t *testing.T) {
	h, calls := recoveryFixture(t)
	items := largeRecoveryCatalog()
	h.listSnapshots = func(_ context.Context, _ DatabaseRestoreConfig, fresh bool) ([]recoverySnapshot, error) {
		if fresh {
			t.Fatal("browser forced repository rescan")
		}
		return items, nil
	}
	response := catalogHTTP(h, "page=200&pageSize=100", true)
	var page snapshotPage
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &page) != nil {
		t.Fatal(response.Body)
	}
	if page.Total != 100000 || len(page.Snapshots) != 100 || len(response.Body.Bytes()) > 50000 || *calls != 0 {
		t.Fatal("catalog was not bounded")
	}
	first := page.Snapshots[0].ID
	response = catalogHTTP(h, "page=200&pageSize=100", true)
	_ = json.Unmarshal(response.Body.Bytes(), &page)
	if page.Snapshots[0].ID != first {
		t.Fatal("unstable pagination")
	}
	h.listSnapshots = func(_ context.Context, _ DatabaseRestoreConfig, fresh bool) ([]recoverySnapshot, error) {
		if !fresh {
			t.Fatal("prepare reused stale membership")
		}
		return []recoverySnapshot{{ID: testRecoverySnapshot}}, nil
	}
	response = recoveryHTTP(h, "POST", `{"action":"prepare","snapshotId":"`+testRecoverySnapshot+`"}`, true)
	if response.Code != 200 || *calls != 1 {
		t.Fatal("off-page selected snapshot could not prepare")
	}
	h.listSnapshots = func(context.Context, DatabaseRestoreConfig, bool) ([]recoverySnapshot, error) {
		t.Fatal("status enumerated snapshots")
		return nil, nil
	}
	// The fixture's status job ID is empty; fail-closed reply is expected, but listing must never run.
	_ = recoveryHTTP(h, "GET", "", true)
	if !slices.IsSortedFunc(items, func(a, b recoverySnapshot) int { return b.at.Compare(a.at) }) {
		t.Fatal("paging mutated cached catalog")
	}
}

func BenchmarkDatabaseRecoveryCatalogPage(b *testing.B) {
	items := largeRecoveryCatalog()
	q := snapshotQuery{page: 500, size: 100, order: "newest", search: "daily"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = filterSnapshotPage(items, q)
	}
}

func TestDatabaseRecoveryCatalogCacheCoalescesAndFailsClosed(t *testing.T) {
	h := &databaseRestoreHandler{}
	var calls atomic.Int32
	load := func() ([]recoverySnapshot, error) {
		calls.Add(1)
		return []recoverySnapshot{{ID: testRecoverySnapshot}}, nil
	}
	var group sync.WaitGroup
	for i := 0; i < 20; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := h.cachedSnapshots(context.Background(), "guid", false, load); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if calls.Load() != 1 {
		t.Fatal("concurrent pages repeated repository enumeration")
	}
	_, _ = h.cachedSnapshots(context.Background(), "guid", true, load)
	if calls.Load() != 2 {
		t.Fatal("explicit refresh reused stale catalog")
	}
	_, _ = h.cachedSnapshots(context.Background(), "changed-guid", false, load)
	if calls.Load() != 3 {
		t.Fatal("repository change reused cached metadata")
	}
	h.snapshotLoaded = time.Now().Add(-2 * time.Minute)
	_, err := h.cachedSnapshots(context.Background(), "changed-guid", false, func() ([]recoverySnapshot, error) { return nil, errors.New("unavailable") })
	if err == nil {
		t.Fatal("expired cache masked repository failure")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = h.cachedSnapshots(ctx, "changed-guid", false, load); err == nil || calls.Load() != 3 {
		t.Fatal("cancelled request enumerated repository")
	}
}
