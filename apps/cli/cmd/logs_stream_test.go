package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/exitcode"
)

func fastBuildFollow(t *testing.T) {
	t.Helper()
	poll, streamLimit, stateLimit := buildStatePoll, buildStreamFailLimit, buildStateFailLimit
	buildStatePoll, buildStreamFailLimit, buildStateFailLimit = 20*time.Millisecond, 1, 1
	t.Cleanup(func() {
		buildStatePoll, buildStreamFailLimit, buildStateFailLimit = poll, streamLimit, stateLimit
	})
}

func rolloutWithBuild(phase, status string, terminal bool) string {
	t := "false"
	if terminal {
		t = "true"
	}
	return `{"phase":"` + phase + `","terminal":` + t + `,"releaseId":null,"url":null,"build":{"status":"` + status + `","step":"build","error":null,"logTail":[]},"pods":{"desired":1,"ready":0,"failing":[]},"hint":null}`
}

func buildFollowServer(stream, rollout, logs http.HandlerFunc) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/observe/deployments/d1/build-logs/stream":
			stream(w, r)
		case "/apiv1/deployments/d1/rollout":
			rollout(w, r)
		case "/apiv1/deployments/d1/logs":
			logs(w, r)
		default:
			w.WriteHeader(404)
		}
	}))
}

func fail500(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(500)
	io.WriteString(w, `{"message":"Internal server error"}`)
}

func say(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, body) }
}

func TestBuildFollowStreamFailureStillPrintsLogsAndFailsTheBuild(t *testing.T) {
	fastBuildFollow(t)
	srv := buildFollowServer(fail500, say(rolloutWithBuild("build_failed", "failed", true)), say(`{"logs":"#1 RUN make\nmake: error\n"}`))
	defer srv.Close()

	var out bytes.Buffer
	err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", &out, buildFollow{})
	if code := exitcode.FromError(err); code != exitcode.DeployFailed {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.DeployFailed)
	}
	if !strings.Contains(out.String(), "make: error") {
		t.Errorf("logs were hidden: %q", out.String())
	}
}

func TestBuildFollowEndsWhenTheStreamStaysSilent(t *testing.T) {
	fastBuildFollow(t)
	var finished atomic.Bool
	stream := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "id: 6\ndata: {\"offset\":6,\"chunk\":\"héllo\\n\"}\n\n")
		w.(http.Flusher).Flush()
		finished.Store(true)
		<-r.Context().Done()
	}
	rollout := func(w http.ResponseWriter, _ *http.Request) {
		if finished.Load() {
			io.WriteString(w, rolloutWithBuild("deploying", "succeeded", false))
			return
		}
		io.WriteString(w, rolloutWithBuild("building", "building", false))
	}
	srv := buildFollowServer(stream, rollout, say(`{"logs":"héllo\nthe rest\n"}`))
	defer srv.Close()

	var out bytes.Buffer
	if err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", &out, buildFollow{}); err != nil {
		t.Fatalf("follow: %v", err)
	}
	if got := out.String(); got != "héllo\nthe rest\n" {
		t.Errorf("output = %q, want each line once", got)
	}
}

func TestBuildFollowPollsLogsWhileTheStreamIsDown(t *testing.T) {
	fastBuildFollow(t)
	var reads atomic.Int32
	logs := func(w http.ResponseWriter, _ *http.Request) {
		if reads.Add(1) == 1 {
			io.WriteString(w, `{"logs":"one\n"}`)
			return
		}
		io.WriteString(w, `{"logs":"one\ntwo\n"}`)
	}
	rollout := func(w http.ResponseWriter, _ *http.Request) {
		if reads.Load() < 2 {
			io.WriteString(w, rolloutWithBuild("building", "building", false))
			return
		}
		io.WriteString(w, rolloutWithBuild("deploying", "succeeded", false))
	}
	srv := buildFollowServer(fail500, rollout, logs)
	defer srv.Close()

	var out bytes.Buffer
	if err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", &out, buildFollow{}); err != nil {
		t.Fatalf("follow: %v", err)
	}
	if got := out.String(); got != "one\ntwo\n" {
		t.Errorf("output = %q", got)
	}
}

func TestBuildFollowGivesUpWhenTheServerKeepsFailing(t *testing.T) {
	fastBuildFollow(t)
	busy := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(503)
		io.WriteString(w, `{"message":"down"}`)
	}
	srv := buildFollowServer(fail500, busy, say(`{"logs":""}`))
	defer srv.Close()

	err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", io.Discard, buildFollow{})
	if code := exitcode.FromError(err); code != exitcode.Server {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.Server)
	}
	if !strings.Contains(err.Error(), "keeps failing") {
		t.Errorf("error = %q, want a clear message", err)
	}
}

func TestBuildFollowRespectsTheTimeout(t *testing.T) {
	fastBuildFollow(t)
	srv := buildFollowServer(fail500, say(rolloutWithBuild("building", "building", false)), say(`{"logs":""}`))
	defer srv.Close()

	started := time.Now()
	err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", io.Discard, buildFollow{Timeout: 200 * time.Millisecond})
	if code := exitcode.FromError(err); code != exitcode.Deadline {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.Deadline)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("took %s to time out", elapsed)
	}
}

func TestBuildFollowStopsOnAccessErrors(t *testing.T) {
	denied := func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		io.WriteString(w, `{"message":"no"}`)
	}
	srv := buildFollowServer(denied, say(rolloutWithBuild("building", "building", false)), say(`{"logs":""}`))
	defer srv.Close()

	err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", io.Discard, buildFollow{})
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 403 {
		t.Fatalf("err = %v, want the 403", err)
	}
}

func TestBuildFollowOnOldServerFallsBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))
	defer srv.Close()

	err := followBuildLogsSSE(context.Background(), api.New(srv.URL, "tok"), "d1", io.Discard, buildFollow{})
	if !errors.Is(err, errSSEUnsupported) {
		t.Fatalf("err = %v, want errSSEUnsupported", err)
	}
}

func TestUpTimesOutWhenTheLogStreamNeverWorks(t *testing.T) {
	fastBuildFollow(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1","slug":"proj"}`)
		case r.URL.Path == "/apiv1/projects/p1/deployments" && r.Method == http.MethodGet:
			io.WriteString(w, `[{"id":"d1","name":"web"}]`)
		case r.URL.Path == "/apiv1/deployments/d1/build-context":
			io.WriteString(w, `{"id":"d1","rolloutSince":"2026-10-27T12:00:00.000Z"}`)
		case r.URL.Path == "/apiv1/observe/deployments/d1/build-logs/stream":
			fail500(w, r)
		case r.URL.Path == "/apiv1/deployments/d1/rollout":
			io.WriteString(w, rolloutWithBuild("building", "building", false))
		case r.URL.Path == "/apiv1/deployments/d1/logs":
			io.WriteString(w, `{"logs":""}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"up", dir, "--project", "proj", "--name", "web", "--wait", "--timeout", "1s", "-o", "json"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if code := exitcode.FromError(err); code != exitcode.Deadline {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.Deadline)
	}
	var result map[string]any
	if jerr := json.Unmarshal([]byte(out), &result); jerr != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", jerr, out)
	}
	if result["phase"] != "building" {
		t.Errorf("result = %v", result)
	}
}

func TestUpFailedBuildExitsWhenTheLogStreamNeverWorks(t *testing.T) {
	fastBuildFollow(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var logsRead atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1","slug":"proj"}`)
		case r.URL.Path == "/apiv1/projects/p1/deployments" && r.Method == http.MethodGet:
			io.WriteString(w, `[{"id":"d1","name":"web"}]`)
		case r.URL.Path == "/apiv1/deployments/d1/build-context":
			io.WriteString(w, `{"id":"d1","rolloutSince":"2026-10-27T12:00:00.000Z"}`)
		case r.URL.Path == "/apiv1/observe/deployments/d1/build-logs/stream":
			fail500(w, r)
		case r.URL.Path == "/apiv1/deployments/d1/rollout":
			io.WriteString(w, rolloutWithBuild("build_failed", "failed", true))
		case r.URL.Path == "/apiv1/deployments/d1/logs":
			logsRead.Store(true)
			io.WriteString(w, `{"logs":"#1 wget: can't connect\n"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"up", dir, "--project", "proj", "--name", "web", "--wait"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if code := exitcode.FromError(err); code != exitcode.DeployFailed {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.DeployFailed)
	}
	if !logsRead.Load() {
		t.Error("the logs were never read")
	}
	var result map[string]any
	if jerr := json.Unmarshal([]byte(out), &result); jerr != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", jerr, out)
	}
	if result["phase"] != "build_failed" {
		t.Errorf("result = %v", result)
	}
}
