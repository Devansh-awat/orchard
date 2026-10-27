package agentspec

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

const parityFixture = "../../../../packages/contracts/test/fixtures/search-parity.json"

func TestTokenizeMatchesTheTypeScriptPort(t *testing.T) {
	cases := map[string][]string{
		"deployments_rollout_get": {"deployment", "rollout", "get"},
		"getDatabaseConnections":  {"get", "database", "connection"},
		"the status of my app":    {"status", "app"},
		"/projects/:id/ingresses": {"project", "id", "ingress"},
		"Policies":                {"policy"},
	}
	for in, want := range cases {
		if got := Tokenize(in); !reflect.DeepEqual(got, want) {
			t.Errorf("Tokenize(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestSearchMatchesTheTypeScriptRanking(t *testing.T) {
	data, err := os.ReadFile(parityFixture)
	if err != nil {
		t.Skipf("parity fixture not available: %v", err)
	}
	var fixture struct {
		Operations []Operation `json:"operations"`
		Cases      []struct {
			Query string `json:"query"`
			Hits  []struct {
				OperationID string  `json:"operationId"`
				Score       float64 `json:"score"`
			} `json:"hits"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		got := Search(fixture.Operations, c.Query, 8)
		if len(c.Hits) == 0 {
			if len(got) != 0 {
				t.Errorf("%q: want no hits, got %v", c.Query, got)
			}
			continue
		}
		if len(got) != len(c.Hits) {
			t.Fatalf("%q: got %d hits, want %d", c.Query, len(got), len(c.Hits))
		}
		for i, want := range c.Hits {
			if got[i].OperationID != want.OperationID || math.Abs(got[i].Score-want.Score) > 1e-9 {
				t.Errorf("%q hit %d: got %s (%v), want %s (%v)", c.Query, i, got[i].OperationID, got[i].Score, want.OperationID, want.Score)
			}
		}
	}
}

var fixtureOps = []Operation{
	{OperationID: "deployments_list", Method: "GET", Path: "/deployments", Summary: "List deployments", Tags: []string{"deployments"}},
	{OperationID: "deployments_get", Method: "GET", Path: "/deployments/:id", Summary: "Get a deployment", Tags: []string{"deployments"}},
	{OperationID: "deployments_logs_list", Method: "GET", Path: "/deployments/:id/logs", Tags: []string{"deployments"}},
	{OperationID: "deployments_recent_builds_list", Method: "GET", Path: "/deployments/recent-builds", Tags: []string{"deployments"}},
	{OperationID: "deployments_restart", Method: "POST", Path: "/deployments/:id/restart", Tags: []string{"deployments"}},
	{OperationID: "databases_delete", Method: "DELETE", Path: "/databases/:id", Tags: []string{"databases"}, Destructive: true},
	{OperationID: "databases_connection_get", Method: "GET", Path: "/databases/:id/connection", Tags: []string{"databases"}, Sensitive: true},
}

func TestSearchFlagsAndLimit(t *testing.T) {
	hits := Search(fixtureOps, "database", 10)
	flags := map[string]Hit{}
	for _, h := range hits {
		flags[h.OperationID] = h
	}
	if !flags["databases_delete"].Destructive || !flags["databases_connection_get"].Sensitive {
		t.Fatalf("flags not carried: %+v", hits)
	}
	if got := Search(fixtureOps, "deployment", 2); len(got) != 2 {
		t.Fatalf("limit ignored: %d", len(got))
	}
	if got := Search(fixtureOps, "restart my app", 3); got[0].OperationID != "deployments_restart" {
		t.Fatalf("restart ranked %s first", got[0].OperationID)
	}
}

func TestFindResolvesIdsTemplatesAndConcretePaths(t *testing.T) {
	cases := map[string]string{
		"databases_get":                  "",
		"deployments_get":                "deployments_get",
		"GET /deployments/:id":           "deployments_get",
		"get /deployments/abc-123/logs":  "deployments_logs_list",
		"GET /deployments/recent-builds": "deployments_recent_builds_list",
		"GET /deployments/abc?x=1":       "deployments_get",
		"POST /nope":                     "",
	}
	for ref, want := range cases {
		op, ok := Find(fixtureOps, ref)
		if want == "" {
			if ok {
				t.Errorf("Find(%q) = %s, want nothing", ref, op.OperationID)
			}
			continue
		}
		if !ok || op.OperationID != want {
			t.Errorf("Find(%q) = %s (%v), want %s", ref, op.OperationID, ok, want)
		}
	}
}

func TestFillPath(t *testing.T) {
	got, missing := FillPath("/deployments/:id/services/:serviceId", map[string]string{"id": "a/b", "serviceId": "s 1"})
	if got != "/deployments/a%2Fb/services/s%201" || len(missing) != 0 {
		t.Fatalf("got %q missing %v", got, missing)
	}
	_, missing = FillPath("/x/:id/y/:other", map[string]string{"id": "1"})
	if !reflect.DeepEqual(missing, []string{"other"}) {
		t.Fatalf("missing = %v", missing)
	}
	if u := UnknownParams("/x/:id", map[string]string{"id": "1", "typo": "2"}); !reflect.DeepEqual(u, []string{"typo"}) {
		t.Fatalf("unknown = %v", u)
	}
}

func specServer(t *testing.T, hits *int32, down *atomic.Bool) *httptest.Server {
	t.Helper()
	body, _ := json.Marshal(Spec{Version: "v1", Operations: fixtureOps})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		if down.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if r.URL.Path != "/apiv1/agent-spec.json" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		io.WriteString(w, string(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestLoaderCachesRevalidatesAndFallsBackOffline(t *testing.T) {
	var hits int32
	var down atomic.Bool
	srv := specServer(t, &hits, &down)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	loader := &Loader{
		APIURL:    srv.URL,
		CachePath: filepath.Join(t.TempDir(), "agent-spec.json"),
		Now:       func() time.Time { return now },
	}

	spec, err := loader.Load(context.Background())
	if err != nil || len(spec.Operations) != len(fixtureOps) || hits != 1 {
		t.Fatalf("first load: err=%v hits=%d", err, hits)
	}

	if _, err := loader.Load(context.Background()); err != nil || hits != 1 {
		t.Fatalf("fresh cache should skip the network: err=%v hits=%d", err, hits)
	}

	now = now.Add(2 * time.Hour)
	if _, err := loader.Load(context.Background()); err != nil || hits != 2 {
		t.Fatalf("stale cache should revalidate: err=%v hits=%d", err, hits)
	}
	data, _ := os.ReadFile(loader.CachePath)
	var c cacheFile
	_ = json.Unmarshal(data, &c)
	if c.ETag != `"v1"` || !c.FetchedAt.Equal(now) {
		t.Fatalf("304 should refresh fetchedAt and keep the etag: %+v", c)
	}

	down.Store(true)
	loader.Refresh = true
	spec, err = loader.Load(context.Background())
	if err != nil || len(spec.Operations) != len(fixtureOps) {
		t.Fatalf("offline should fall back to cache: err=%v", err)
	}

	other := &Loader{APIURL: "http://other.invalid", CachePath: loader.CachePath, HTTP: &http.Client{Timeout: time.Second}}
	if _, err := other.Load(context.Background()); err == nil {
		t.Fatal("a cache for another server must not be used")
	}
}
