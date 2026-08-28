package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/spf13/cobra"
)

// eventsTestRoot isolates config in a temp HOME and points the client at the
// given httptest server. events is added locally when root.go has not
// registered it yet (root registration is owned elsewhere).
func eventsTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	for _, c := range root.Commands() {
		if c.Name() == "events" {
			return root
		}
	}
	root.AddCommand(eventsCmd())
	return root
}

// eventsSSEWrite emits one SSE frame (same shape as internal/api/sse_test.go).
func eventsSSEWrite(w http.ResponseWriter, id, data string) {
	if id != "" {
		fmt.Fprintf(w, "id: %s\n", id)
	}
	fmt.Fprintf(w, "data: %s\n\n", data)
	w.(http.Flusher).Flush()
}

// eventsCaptureLines swaps os.Stdout for a pipe and streams its lines into the
// returned channel; the cleanup func restores stdout.
func eventsCaptureLines(t *testing.T) (<-chan string, func()) {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	return lines, func() {
		os.Stdout = orig
		w.Close()
	}
}

// eventsWaitDone asserts the command goroutine finished cleanly (exit 0 path).
func eventsWaitDone(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("command returned %v, want nil after cancel", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command did not exit after cancel")
	}
}

func eventsRecvLine(t *testing.T, lines <-chan string) string {
	t.Helper()
	select {
	case line, ok := <-lines:
		if !ok {
			t.Fatal("stdout closed before a line arrived")
		}
		return line
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for output")
	}
	return ""
}

func TestEventsTailStreamsFilteredNDJSON(t *testing.T) {
	queries := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/o1":
			io.WriteString(w, `{"id":"o1"}`)
		case "/apiv1/events/orgs/o1":
			select {
			case queries <- r.URL.RawQuery:
			default:
			}
			w.Header().Set("Content-Type", "text/event-stream")
			eventsSSEWrite(w, "7-1", `{"organizationId":"o1","type":"heartbeat"}`)
			eventsSSEWrite(w, "7-2", `{"organizationId":"o1","type":"database.changed","id":"db1"}`)
			eventsSSEWrite(w, "7-3", `{"organizationId":"o1","type":"deployment.changed","id":"d1","projectId":"p1","ts":42,"payload":{"a":1}}`)
			<-r.Context().Done()
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := eventsTestRoot(t, srv.URL)
	root.SetArgs([]string{"events", "tail", "--org", "o1", "--since-id", "42-0", "--types", "deployment.changed,build.changed", "-o", "json"})

	lines, restore := eventsCaptureLines(t)
	defer restore()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()

	line := eventsRecvLine(t, lines)
	cancel()
	eventsWaitDone(t, done)

	var rec map[string]any
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		t.Fatalf("line %q is not JSON: %v", line, err)
	}
	// heartbeat is dropped by the client and db1 by --types, so the first
	// line must be the deployment event, with the SSE id surfaced.
	if rec["eventId"] != "7-3" || rec["type"] != "deployment.changed" {
		t.Errorf("eventId/type = %v/%v, want 7-3/deployment.changed", rec["eventId"], rec["type"])
	}
	if rec["id"] != "d1" || rec["projectId"] != "p1" || rec["ts"] != float64(42) {
		t.Errorf("id/projectId/ts = %v/%v/%v", rec["id"], rec["projectId"], rec["ts"])
	}
	if !reflect.DeepEqual(rec["payload"], map[string]any{"a": float64(1)}) {
		t.Errorf("payload = %v, want {a:1}", rec["payload"])
	}
	if q := <-queries; !strings.Contains(q, "lastEventId=42-0") {
		t.Errorf("first connect query = %q, want lastEventId=42-0 from --since-id", q)
	}
}

func TestEventsTailTableLine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/o1":
			io.WriteString(w, `{"id":"o1"}`)
		case "/apiv1/events/orgs/o1":
			w.Header().Set("Content-Type", "text/event-stream")
			eventsSSEWrite(w, "1-1", `{"organizationId":"o1","type":"pod.changed","id":"web-1","projectId":"p1","ts":1700000000000}`)
			<-r.Context().Done()
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := eventsTestRoot(t, srv.URL)
	root.SetArgs([]string{"events", "tail", "--org", "o1", "-o", "table"})

	lines, restore := eventsCaptureLines(t)
	defer restore()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()

	line := eventsRecvLine(t, lines)
	cancel()
	eventsWaitDone(t, done)

	for _, want := range []string{"pod.changed", "p1", "web-1"} {
		if !strings.Contains(line, want) {
			t.Errorf("table line %q missing %q", line, want)
		}
	}
	if strings.Contains(line, "{") {
		t.Errorf("table line %q looks like JSON", line)
	}
}

func TestDeployLogsBuildFollowFirstFetch(t *testing.T) {
	hits := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/observe/deployments/d1/build-logs/stream" {
			w.WriteHeader(404)
			return
		}
		select {
		case hits <- r.Method + " " + r.URL.Path:
		default:
		}
		io.WriteString(w, `{"logs":"step 1\n"}`)
	}))
	defer srv.Close()

	root := eventsTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "logs", "d1", "--build", "--follow"})

	lines, restore := eventsCaptureLines(t)
	defer restore()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()

	select {
	case h := <-hits:
		if h != "GET /apiv1/deployments/d1/logs" {
			t.Errorf("first fetch = %q, want GET /apiv1/deployments/d1/logs", h)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("follow never fetched")
	}
	if got := eventsRecvLine(t, lines); got != "step 1" {
		t.Errorf("first line = %q, want %q", got, "step 1")
	}
	cancel()
	eventsWaitDone(t, done)
}

func TestDeployLogsFollowAggregatesPods(t *testing.T) {
	logHits := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/observe/deployments/d1/logs/stream":
			w.WriteHeader(404)
		case "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1","namespace":"ns1"}`)
		case "/apiv1/deployments/d1/pods":
			io.WriteString(w, `[{"name":"web-1"}]`)
		case "/apiv1/pods/web-1/logs":
			select {
			case logHits <- r.URL.RawQuery:
			default:
			}
			io.WriteString(w, `{"logs":"hello\n"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := eventsTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "logs", "d1", "--follow", "--tail", "42"})

	lines, restore := eventsCaptureLines(t)
	defer restore()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()

	select {
	case q := <-logHits:
		for _, want := range []string{"namespace=ns1", "tailLines=42"} {
			if !strings.Contains(q, want) {
				t.Errorf("pod logs query = %q, missing %q", q, want)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("follow never fetched pod logs")
	}
	if got := eventsRecvLine(t, lines); got != "hello" {
		t.Errorf("first line = %q, want %q", got, "hello")
	}
	cancel()
	eventsWaitDone(t, done)
}

func TestPodLogsFollowFirstFetch(t *testing.T) {
	hits := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case hits <- r.Method + " " + r.URL.Path + "?" + r.URL.RawQuery:
		default:
		}
		io.WriteString(w, `{"logs":"pod line\n"}`)
	}))
	defer srv.Close()

	root := eventsTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "logs", "pod1", "--namespace", "custom", "--follow"})

	lines, restore := eventsCaptureLines(t)
	defer restore()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()

	select {
	case h := <-hits:
		if !strings.HasPrefix(h, "GET /apiv1/pods/pod1/logs?") || !strings.Contains(h, "namespace=custom") {
			t.Errorf("first fetch = %q, want GET /apiv1/pods/pod1/logs with namespace=custom", h)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("follow never fetched")
	}
	if got := eventsRecvLine(t, lines); got != "pod line" {
		t.Errorf("first line = %q, want %q", got, "pod line")
	}
	cancel()
	eventsWaitDone(t, done)
}

func TestJobRunLogsFollowStopsOnTerminalStatus(t *testing.T) {
	var runFetches, logFetches int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/job-runs/r1":
			runFetches++
			io.WriteString(w, `{"id":"r1","status":"succeeded","steps":[{"stepOrder":1,"name":"a","status":"succeeded"}]}`)
		case "/apiv1/job-runs/r1/steps/1/logs":
			logFetches++
			io.WriteString(w, `{"logs":"done\n"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := eventsTestRoot(t, srv.URL)
	root.SetArgs([]string{"job-run", "logs", "r1", "--follow"})

	lines, restore := eventsCaptureLines(t)
	defer restore()
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(context.Background()) }()

	// the run is already terminal, so follow must print the final fetch and
	// stop on its own — no external cancel.
	eventsWaitDone(t, done)
	if got := eventsRecvLine(t, lines); got != "done" {
		t.Errorf("output line = %q, want %q", got, "done")
	}
	if runFetches != 1 || logFetches != 1 {
		t.Errorf("fetches = %d run / %d logs, want 1/1 (stop after the final fetch)", runFetches, logFetches)
	}
}

func TestWatchRefusesNonTTY(t *testing.T) {
	var hitCount int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitCount++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	for _, args := range [][]string{
		{"deploy", "get", "d1", "--watch"},
		{"db", "get", "db1", "--watch"},
		{"job-run", "get", "r1", "--watch"},
	} {
		root := eventsTestRoot(t, srv.URL)
		root.SetArgs(args)
		err := root.Execute()
		if err == nil {
			t.Errorf("args %v: expected a usage error without a TTY", args)
			continue
		}
		var usage *exitcode.UsageError
		if !errors.As(err, &usage) {
			t.Errorf("args %v: err %v is not a usage error", args, err)
		}
	}
	if hitCount != 0 {
		t.Errorf("server saw %d requests, want 0 (refusal must come before any fetch)", hitCount)
	}
}
