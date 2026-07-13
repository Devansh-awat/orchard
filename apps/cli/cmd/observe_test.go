package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// observeTestRoot wires observeCmd under a real root so persistent flags
// (-o, --yes) behave exactly as in production, with config isolated to a temp
// HOME and the API pointed at the given httptest server.
func observeTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	root.AddCommand(observeCmd())
	return root
}

func TestObserveOverviewPath(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"uptime":"2026-07-01T00:00:00.000Z","podCount":2,"restarts":1,"cpuPercent":12.5,"memoryPercent":40.2,"httpRequestRate":3.4,"httpErrorRate":0.12,"httpAvgLatency":85}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "overview", "dep1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe overview: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/observe/deployments/dep1/overview" {
		t.Errorf("request = %s %s, want GET /apiv1/observe/deployments/dep1/overview", gotMethod, gotPath)
	}
}

func TestObserveOverviewTableHandlesNulls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"uptime":"2026-07-01T00:00:00.000Z","podCount":0,"restarts":0,"cpuPercent":null,"memoryPercent":null,"httpRequestRate":null,"httpErrorRate":null,"httpAvgLatency":null}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "overview", "dep1", "-o", "table"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe overview -o table: %v", err)
	}
}

func TestObserveLogsQueryParams(t *testing.T) {
	var gotPath string
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		io.WriteString(w, `{"entries":[{"timestamp":"2026-07-12T10:00:00Z","level":"ERROR","message":"boom","lines":["boom"],"raw":"boom"}]}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "logs", "dep1", "--level", "error", "--search", "boom", "--tail", "500"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe logs: %v", err)
	}
	if gotPath != "/apiv1/observe/deployments/dep1/logs/structured" {
		t.Errorf("path = %q, want /apiv1/observe/deployments/dep1/logs/structured", gotPath)
	}
	for k, want := range map[string]string{
		"tailLines": "500",
		"level":     "error",
		"search":    "boom",
	} {
		if got := gotQuery[k]; len(got) != 1 || got[0] != want {
			t.Errorf("query %s = %v, want %q", k, got, want)
		}
	}
}

func TestObserveLogsDefaultsOmitEmptyFilters(t *testing.T) {
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		io.WriteString(w, `{"entries":[]}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "logs", "dep1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe logs: %v", err)
	}
	if got := gotQuery["tailLines"]; len(got) != 1 || got[0] != "200" {
		t.Errorf("tailLines = %v, want 200", gotQuery["tailLines"])
	}
	for _, k := range []string{"level", "search"} {
		if _, ok := gotQuery[k]; ok {
			t.Errorf("query %s should be omitted when empty, got %v", k, gotQuery[k])
		}
	}
}

func TestObserveRenderLogEntriesTable(t *testing.T) {
	entries := []map[string]any{
		{
			"timestamp": "2026-07-12T10:00:00Z",
			"level":     "ERROR",
			"message":   "TypeError: boom",
			"raw":       "TypeError: boom\n    at handler (app.js:1)",
		},
		{"level": "info", "message": "listening on :3000", "raw": "listening on :3000"},
	}
	text, err := observeRenderLogEntries(entries, false)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{"10:00:00", "ERROR", "TypeError: boom", "INFO", "listening on :3000"} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered logs missing %q in:\n%s", want, text)
		}
	}
	if !strings.Contains(text, strings.Repeat(" ", 17)+"    at handler (app.js:1)") {
		t.Errorf("continuation line not indented in:\n%s", text)
	}
}

func TestObserveRenderLogEntriesNDJSON(t *testing.T) {
	entries := []map[string]any{
		{"level": "ERROR", "message": "boom"},
		{"level": "INFO", "message": "ok"},
	}
	text, err := observeRenderLogEntries(entries, true)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d NDJSON lines, want 2:\n%s", len(lines), text)
	}
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Errorf("line %q is not valid JSON: %v", l, err)
		}
	}
}

func TestObserveHTTPMetricsPath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"requestRate":[{"x":1,"y":2.5}],"errorRate":[{"x":1,"y":0.1}],"latencyAvg":[{"x":1,"y":80}],"latencyMax":[{"x":1,"y":250}]}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "http", "dep1", "-o", "table"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe http: %v", err)
	}
	if gotPath != "/apiv1/observe/deployments/dep1/http-metrics" {
		t.Errorf("path = %q, want /apiv1/observe/deployments/dep1/http-metrics", gotPath)
	}
}

func TestObserveHTTPMetricsEmptySeries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"requestRate":[],"errorRate":[],"latencyAvg":[],"latencyMax":[]}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "http", "dep1", "-o", "table"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe http (empty): %v", err)
	}
}

func TestObserveSeriesLatest(t *testing.T) {
	var series any
	if err := json.Unmarshal([]byte(`[{"x":1,"y":2},{"x":2,"y":7.5},{"x":3,"y":null}]`), &series); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	y, ok := observeSeriesLatest(series)
	if !ok || y != 7.5 {
		t.Errorf("latest = %v/%v, want 7.5/true (skip trailing null)", y, ok)
	}
	if _, ok := observeSeriesLatest([]any{}); ok {
		t.Error("empty series should report no value")
	}
	if _, ok := observeSeriesLatest(nil); ok {
		t.Error("nil series should report no value")
	}
}

func TestObserveErrorsWindowQuery(t *testing.T) {
	var gotPath, gotWindow string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotWindow = r.URL.Query().Get("window")
		io.WriteString(w, `{"errors":[{"fingerprint":"abcd1234abcd1234","type":"TypeError","message":"boom","count":3,"firstSeen":"2026-07-12T09:00:00Z","lastSeen":"2026-07-12T10:00:00Z","samples":[],"trend":"rising"}]}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "errors", "dep1", "--window", "6h", "-o", "table"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe errors: %v", err)
	}
	if gotPath != "/apiv1/observe/deployments/dep1/errors" {
		t.Errorf("path = %q, want /apiv1/observe/deployments/dep1/errors", gotPath)
	}
	if gotWindow != "360" {
		t.Errorf("window = %q, want 360 (6h in minutes)", gotWindow)
	}
}

func TestObserveErrorsDefaultWindow(t *testing.T) {
	var gotWindow string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotWindow = r.URL.Query().Get("window")
		io.WriteString(w, `{"errors":[]}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "errors", "dep1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe errors: %v", err)
	}
	if gotWindow != "60" {
		t.Errorf("window = %q, want 60 (default 1h)", gotWindow)
	}
}

func TestObserveErrorsRejectsBadWindow(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "errors", "dep1", "--window", "soon"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--window") {
		t.Fatalf("want a --window parse error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestObserveWindowMinutes(t *testing.T) {
	for in, want := range map[string]int{"15m": 15, "1h": 60, "6h": 360, "24h": 1440} {
		got, err := observeWindowMinutes(in)
		if err != nil || got != want {
			t.Errorf("observeWindowMinutes(%q) = %d/%v, want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "bogus", "30s", "0m"} {
		if _, err := observeWindowMinutes(in); err == nil {
			t.Errorf("observeWindowMinutes(%q) should fail", in)
		}
	}
}

func TestObserveRuntimePath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"language":"node","framework":"nextjs","version":"20.1","confidence":"high","detectedFrom":"build_logs"}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "runtime", "dep1", "-o", "table"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe runtime: %v", err)
	}
	if gotPath != "/apiv1/observe/deployments/dep1/runtime" {
		t.Errorf("path = %q, want /apiv1/observe/deployments/dep1/runtime", gotPath)
	}
}

func TestObserveCapabilitiesPath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"logs":true,"containerMetrics":true,"httpMetrics":false,"customMetrics":false,"traces":false,"runtime":null}`)
	}))
	defer srv.Close()

	root := observeTestRoot(t, srv.URL)
	root.SetArgs([]string{"observe", "capabilities", "dep1", "-o", "table"})
	if err := root.Execute(); err != nil {
		t.Fatalf("observe capabilities: %v", err)
	}
	if gotPath != "/apiv1/observe/deployments/dep1/capabilities" {
		t.Errorf("path = %q, want /apiv1/observe/deployments/dep1/capabilities", gotPath)
	}
}

func TestObserveRuntimeSummary(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, "-"},
		{map[string]any{"language": "unknown"}, "unknown"},
		{map[string]any{"language": "node"}, "node"},
		{map[string]any{"language": "node", "framework": "nextjs", "version": "20.1"}, "node (nextjs) 20.1"},
	}
	for _, c := range cases {
		if got := observeRuntimeSummary(c.in); got != c.want {
			t.Errorf("observeRuntimeSummary(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
