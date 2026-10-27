package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/hackclub/orchard/cli/internal/exitcode"
)

func rolloutBody(phase string, terminal bool) string {
	return `{"phase":"` + phase + `","terminal":` + strconv.FormatBool(terminal) +
		`,"releaseId":"rel-1","url":"https://web.example.dev","build":{"status":"succeeded","step":"complete","error":null,"logTail":[]},"pods":{"desired":1,"ready":1,"failing":[]},"hint":null}`
}

func TestUpFailedBuildExitsDeployFailed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\nEXPOSE 8080\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var uploaded, streamed, diagnosed atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1","slug":"proj"}`)
		case r.URL.Path == "/apiv1/projects/p1/deployments" && r.Method == http.MethodGet:
			io.WriteString(w, `[{"id":"d1","name":"web"}]`)
		case r.URL.Path == "/apiv1/deployments/d1/build-context" && r.Method == http.MethodPost:
			uploaded.Store(true)
			io.WriteString(w, `{"id":"d1","rolloutSince":"2026-10-27T12:00:00.000Z","releaseId":null}`)
		case r.URL.Path == "/apiv1/observe/deployments/d1/build-logs/stream":
			streamed.Store(true)
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"offset\":0,\"chunk\":\"#5 RUN npm run build\\n\"}\n\n")
			io.WriteString(w, "data: {\"done\":true,\"status\":\"failed\",\"step\":\"build\"}\n\n")
		case r.URL.Path == "/apiv1/deployments/d1/rollout":
			diagnosed.Store(true)
			if got := r.URL.Query().Get("since"); got != "2026-10-27T12:00:00.000Z" {
				t.Errorf("rollout since = %q, want the upload's rolloutSince", got)
			}
			io.WriteString(w, `{"phase":"build_failed","terminal":true,"releaseId":null,"url":null,"build":{"status":"failed","step":"build","error":"npm ERR! missing script: build","logTail":["npm ERR! missing script: build"]},"pods":{"desired":1,"ready":0,"failing":[]},"hint":"fix it"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"up", dir, "--project", "proj", "--name", "web", "-o", "json"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if err == nil {
		t.Fatal("up succeeded on a failed build")
	}
	if code := exitcode.FromError(err); code != exitcode.DeployFailed {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.DeployFailed)
	}
	if !uploaded.Load() || !streamed.Load() || !diagnosed.Load() {
		t.Fatalf("uploaded=%v streamed=%v diagnosed=%v", uploaded.Load(), streamed.Load(), diagnosed.Load())
	}
	if strings.Contains(out, "RUN npm run build") {
		t.Errorf("build log leaked onto stdout in JSON mode:\n%s", out)
	}
	var result map[string]any
	if jerr := json.Unmarshal([]byte(out), &result); jerr != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", jerr, out)
	}
	if result["deploymentId"] != "d1" || result["phase"] != "build_failed" {
		t.Errorf("result = %v", result)
	}
}

func TestUpWaitsForLiveAndPrintsResult(t *testing.T) {
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
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"done\":true,\"status\":\"succeeded\"}\n\n")
		case r.URL.Path == "/apiv1/deployments/d1/rollout":
			if r.URL.Query().Get("wait") != "1" {
				t.Errorf("rollout wait = %q, want 1", r.URL.Query().Get("wait"))
			}
			io.WriteString(w, rolloutBody("live", true))
		case r.URL.Path == "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"up", dir, "--project", "proj", "--name", "web", "--wait", "-o", "json"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if err != nil {
		t.Fatalf("up --wait: %v", err)
	}
	var result map[string]any
	if jerr := json.Unmarshal([]byte(out), &result); jerr != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", jerr, out)
	}
	for k, want := range map[string]string{"deploymentId": "d1", "releaseId": "rel-1", "phase": "live", "url": "https://web.example.dev"} {
		if result[k] != want {
			t.Errorf("%s = %v, want %q", k, result[k], want)
		}
	}
}

func TestRestartWaitCrashingExitsDeployCrashing(t *testing.T) {
	var pinned atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/deployments/d1/restart":
			io.WriteString(w, `{"success":true,"rolloutSince":"2026-10-27T12:00:00.000Z","releaseId":null}`)
		case r.URL.Path == "/apiv1/deployments/d1/rollout":
			pinned.Store(r.URL.Query().Get("since") == "2026-10-27T12:00:00.000Z")
			io.WriteString(w, `{"phase":"crashing","terminal":true,"releaseId":"rel-1","url":null,"build":{"status":"succeeded","step":"complete","error":null,"logTail":[]},"pods":{"desired":1,"ready":0,"failing":[{"pod":"web-abc","container":"app","reason":"CrashLoopBackOff","message":null,"exitCode":1,"restarts":4,"logTail":["Error: DATABASE_URL is not set"]}]},"hint":"The app keeps exiting"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "restart", "d1", "--wait", "--timeout", "5s", "-o", "json"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if code := exitcode.FromError(err); code != exitcode.DeployCrashing {
		t.Fatalf("exit code = %d (%v), want %d", code, err, exitcode.DeployCrashing)
	}
	if !strings.Contains(err.Error(), "web-abc") || !strings.Contains(err.Error(), "CrashLoopBackOff") {
		t.Errorf("error %q does not name the pod and reason", err)
	}
	if !pinned.Load() {
		t.Error("rollout was not pinned to the restart's rolloutSince")
	}
	if !strings.Contains(out, "DATABASE_URL is not set") {
		t.Errorf("stdout JSON is missing the pod log tail:\n%s", out)
	}
}

func TestDeployStatusPrintsRollout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/deployments/d1/rollout" || r.URL.Query().Get("wait") != "" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.String())
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, rolloutBody("deploying", false))
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "status", "d1", "-o", "json"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if err != nil {
		t.Fatalf("deploy status: %v", err)
	}
	var result map[string]any
	if jerr := json.Unmarshal([]byte(out), &result); jerr != nil {
		t.Fatalf("not JSON: %v\n%s", jerr, out)
	}
	if result["phase"] != "deploying" || result["deploymentId"] != "d1" {
		t.Errorf("result = %v", result)
	}
}

func TestRollbackWithoutIDFallsBackToPreviousImage(t *testing.T) {
	var rolledTo string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/deployments/d1/rollback":
			w.WriteHeader(404)
			io.WriteString(w, `{"message":"Cannot POST"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/deployments/d1/image-history":
			io.WriteString(w, `[
				{"id":"h3","image":"app:v3","isActive":true,"createdAt":"2026-10-27T10:00:00Z"},
				{"id":"h1","image":"app:v1","isActive":false,"createdAt":"2026-10-25T10:00:00Z"},
				{"id":"h2","image":"app:v2","isActive":false,"createdAt":"2026-10-26T10:00:00Z"}
			]`)
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/apiv1/deployments/d1/rollback/"):
			rolledTo = strings.TrimPrefix(r.URL.Path, "/apiv1/deployments/d1/rollback/")
			io.WriteString(w, `{"id":"d1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "rollback", "d1", "--yes"})
	if err := root.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("deploy rollback: %v", err)
	}
	if rolledTo != "h2" {
		t.Errorf("rolled back to %q, want h2 (the release before the active one)", rolledTo)
	}
}

func TestRollbackWithoutIDUsesServerWhenSupported(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/apiv1/deployments/d1/rollback" {
			hit = true
			io.WriteString(w, `{"id":"d1"}`)
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(404)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "rollback", "d1", "--yes"})
	if err := root.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("deploy rollback: %v", err)
	}
	if !hit {
		t.Error("server rollback-to-previous endpoint was not called")
	}
}

func TestEnvPullJSONPrintsVarsWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1","slug":"proj"}`)
		case "/apiv1/projects/p1/environments":
			io.WriteString(w, `[{"id":"e1","name":"production","isDefault":true}]`)
		case "/apiv1/environments/e1/shared-vars":
			io.WriteString(w, `[{"key":"PORT","value":"3000","secret":false},{"key":"API_KEY","value":null,"secret":true}]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"env", "pull", "e1", "--project", "proj", "-o", "json"})
	var err error
	out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
	if err != nil {
		t.Fatalf("env pull -o json: %v", err)
	}
	var vars []map[string]any
	if jerr := json.Unmarshal([]byte(out), &vars); jerr != nil {
		t.Fatalf("not JSON: %v\n%s", jerr, out)
	}
	if len(vars) != 2 {
		t.Fatalf("vars = %v", vars)
	}
	if vars[0]["key"] != "API_KEY" || vars[0]["secret"] != true || vars[0]["value"] != nil {
		t.Errorf("secret var = %v, want {key: API_KEY, secret: true, value: null}", vars[0])
	}
	if vars[1]["key"] != "PORT" || vars[1]["value"] != "3000" || vars[1]["secret"] != false {
		t.Errorf("plain var = %v", vars[1])
	}
	if _, serr := os.Stat(filepath.Join(dir, ".env.orchard")); serr == nil {
		t.Error("-o json without --out should not write .env.orchard")
	}
}

func TestLogsAliasHitsBuildLogs(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Path
		io.WriteString(w, `{"logs":"hello","status":"running","buildError":null}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"logs", "d1", "--build"})
	captureStdout(t, func() {
		if err := root.ExecuteContext(context.Background()); err != nil {
			t.Fatalf("logs --build: %v", err)
		}
	})
	if got != "/apiv1/deployments/d1/logs" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/logs", got)
	}
}
