package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// jobTestRoot isolates config in a temp HOME and points the client at the
// given httptest server. job/job-run are added locally when root.go has not
// registered them yet (root registration is owned elsewhere).
func jobTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	hasJob, hasJobRun := false, false
	for _, c := range root.Commands() {
		switch c.Name() {
		case "job":
			hasJob = true
		case "job-run":
			hasJobRun = true
		}
	}
	if !hasJob {
		root.AddCommand(jobCmd())
	}
	if !hasJobRun {
		root.AddCommand(jobRunCmd())
	}
	return root
}

func jobDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

func jobWriteStepsFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "steps.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write steps file: %v", err)
	}
	return path
}

func TestJobListOrgScope(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/organizations/o1/jobs":
			gotPath = r.URL.Path
			io.WriteString(w, `[{"id":"j1","name":"nightly","scheduleCron":"0 2 * * *","enabled":false,"lastRun":{"number":3,"status":"succeeded"}}]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "list", "--org", "myorg"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job list: %v", err)
	}
	if gotPath != "/apiv1/organizations/o1/jobs" {
		t.Errorf("list path = %q, want /apiv1/organizations/o1/jobs", gotPath)
	}
}

func TestJobListProjectScope(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/projects/slug/myproj":
			io.WriteString(w, `{"id":"p1","slug":"myproj"}`)
		case "/apiv1/projects/p1/jobs":
			gotPath = r.URL.Path
			io.WriteString(w, `[]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "list", "--project", "myproj"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job list: %v", err)
	}
	if gotPath != "/apiv1/projects/p1/jobs" {
		t.Errorf("list path = %q, want /apiv1/projects/p1/jobs", gotPath)
	}
}

func TestJobGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"j1","name":"nightly","scheduleCron":"0 2 * * *","enabled":true,"steps":[{"stepOrder":1,"name":"refresh","type":"script","scriptRuntime":"bash"}]}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "get", "j1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/jobs/j1" {
		t.Errorf("request = %s %s, want GET /apiv1/jobs/j1", gotMethod, gotPath)
	}
}

func TestJobCreateBody(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/jobs":
			gotPath = r.URL.Path
			gotBody = jobDecodeBody(t, r)
			io.WriteString(w, `{"id":"j1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	steps := jobWriteStepsFile(t, `[{"name":"refresh","type":"script","scriptRuntime":"bash","script":"echo hi"}]`)
	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"job", "create", "--project", "proj",
		"--name", "nightly", "--cron", "0 2 * * *", "--steps", steps,
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("job create: %v", err)
	}
	if gotPath != "/apiv1/projects/p1/jobs" {
		t.Fatalf("path = %q, want /apiv1/projects/p1/jobs", gotPath)
	}
	if gotBody["name"] != "nightly" || gotBody["scheduleCron"] != "0 2 * * *" {
		t.Errorf("name/scheduleCron = %v/%v", gotBody["name"], gotBody["scheduleCron"])
	}
	sent, ok := gotBody["steps"].([]any)
	if !ok || len(sent) != 1 {
		t.Fatalf("steps = %v, want 1 step", gotBody["steps"])
	}
	step, _ := sent[0].(map[string]any)
	if step["type"] != "script" || step["scriptRuntime"] != "bash" {
		t.Errorf("step = %v, want script/bash", step)
	}
	if _, present := gotBody["enabled"]; present {
		t.Errorf("body = %v, want enabled omitted without --paused", gotBody)
	}
}

func TestJobCreateStepsWrappedObject(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/jobs":
			gotBody = jobDecodeBody(t, r)
			io.WriteString(w, `{"id":"j1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	steps := jobWriteStepsFile(t, `{"steps":[{"type":"image","image":"alpine:3"}]}`)
	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "create", "--project", "proj", "--name", "n", "--steps", steps, "--paused"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job create: %v", err)
	}
	sent, ok := gotBody["steps"].([]any)
	if !ok || len(sent) != 1 {
		t.Fatalf("steps = %v, want 1 step from wrapped object", gotBody["steps"])
	}
	if gotBody["enabled"] != false {
		t.Errorf("enabled = %v, want false with --paused", gotBody["enabled"])
	}
}

func TestJobCreateBadStepsFile(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	steps := jobWriteStepsFile(t, `"not steps"`)
	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "create", "--project", "proj", "--name", "n", "--steps", steps})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "JSON array of steps") {
		t.Fatalf("want a steps-file parse error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestJobUpdateBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = jobDecodeBody(t, r)
		io.WriteString(w, `{"id":"j1"}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "update", "j1", "--name", "renamed", "--paused"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job update: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/jobs/j1" {
		t.Errorf("request = %s %s, want PATCH /apiv1/jobs/j1", gotMethod, gotPath)
	}
	if gotBody["name"] != "renamed" || gotBody["enabled"] != false {
		t.Errorf("name/enabled = %v/%v, want renamed/false", gotBody["name"], gotBody["enabled"])
	}
	if _, present := gotBody["scheduleCron"]; present {
		t.Errorf("body = %v, want scheduleCron omitted when flag untouched", gotBody)
	}
}

func TestJobUpdateCronEmptyClearsSchedule(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = jobDecodeBody(t, r)
		io.WriteString(w, `{"id":"j1"}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "update", "j1", "--cron", ""})
	if err := root.Execute(); err != nil {
		t.Fatalf("job update --cron '': %v", err)
	}
	if v, ok := gotBody["scheduleCron"]; !ok || v != nil {
		t.Errorf("scheduleCron = %v (present=%v), want explicit null", v, ok)
	}
}

func TestJobUpdateRequiresChange(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "update", "j1"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("want a nothing-to-update error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestJobPauseResume(t *testing.T) {
	for cmdName, wantEnabled := range map[string]bool{"pause": false, "resume": true} {
		var gotMethod, gotPath string
		var gotBody map[string]any
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotMethod, gotPath = r.Method, r.URL.Path
			gotBody = jobDecodeBody(t, r)
			io.WriteString(w, `{"id":"j1"}`)
		}))

		root := jobTestRoot(t, srv.URL)
		root.SetArgs([]string{"job", cmdName, "j1"})
		if err := root.Execute(); err != nil {
			t.Fatalf("job %s: %v", cmdName, err)
		}
		if gotMethod != http.MethodPatch || gotPath != "/apiv1/jobs/j1" {
			t.Errorf("%s request = %s %s, want PATCH /apiv1/jobs/j1", cmdName, gotMethod, gotPath)
		}
		if gotBody["enabled"] != wantEnabled {
			t.Errorf("%s enabled = %v, want %v", cmdName, gotBody["enabled"], wantEnabled)
		}
		srv.Close()
	}
}

func TestJobDelete(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"success":true}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "delete", "j1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/jobs/j1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/jobs/j1", gotMethod, gotPath)
	}
}

func TestJobDeleteRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "delete", "j1"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestJobStepsSet(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = jobDecodeBody(t, r)
		io.WriteString(w, `{"id":"j1"}`)
	}))
	defer srv.Close()

	steps := jobWriteStepsFile(t, `[{"type":"app","deploymentId":"d1","command":"node prune.js"}]`)
	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "steps", "set", "j1", "--file", steps})
	if err := root.Execute(); err != nil {
		t.Fatalf("job steps set: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/apiv1/jobs/j1/steps" {
		t.Errorf("request = %s %s, want PUT /apiv1/jobs/j1/steps", gotMethod, gotPath)
	}
	sent, ok := gotBody["steps"].([]any)
	if !ok || len(sent) != 1 {
		t.Fatalf("steps = %v, want 1 step", gotBody["steps"])
	}
	step, _ := sent[0].(map[string]any)
	if step["deploymentId"] != "d1" || step["command"] != "node prune.js" {
		t.Errorf("step = %v, want app step with deploymentId/command", step)
	}
}

func TestJobRunTrigger(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = jobDecodeBody(t, r)
		io.WriteString(w, `{"id":"r1","number":4,"status":"pending"}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "run", "j1", "--allow-concurrent"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job run: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/jobs/j1/runs" {
		t.Errorf("request = %s %s, want POST /apiv1/jobs/j1/runs", gotMethod, gotPath)
	}
	if gotBody["allowConcurrent"] != true {
		t.Errorf("allowConcurrent = %v, want true", gotBody["allowConcurrent"])
	}
}

func TestJobRunWaitPollsRun(t *testing.T) {
	var polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/jobs/j1/runs":
			io.WriteString(w, `{"id":"r1","number":4,"status":"pending"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/job-runs/r1":
			polls++
			io.WriteString(w, `{"id":"r1","status":"succeeded"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "run", "j1", "--wait", "--timeout", "5s"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job run --wait: %v", err)
	}
	if polls != 1 {
		t.Errorf("run polls = %d, want 1", polls)
	}
}

func TestJobRunWaitFailureStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/jobs/j1/runs":
			io.WriteString(w, `{"id":"r1","number":4,"status":"pending"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/job-runs/r1":
			io.WriteString(w, `{"id":"r1","status":"timed_out"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "run", "j1", "--wait", "--timeout", "5s"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "timed_out") {
		t.Fatalf("want a terminal-failure error naming timed_out, got %v", err)
	}
}

func TestJobRunsSinglePage(t *testing.T) {
	var gotPath, gotLimit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotLimit = r.URL.Query().Get("limit")
		io.WriteString(w, `{"runs":[{"id":"r1","number":4,"status":"succeeded","trigger":"manual"}],"nextCursor":null}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "runs", "j1", "--limit", "10"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job runs: %v", err)
	}
	if gotPath != "/apiv1/jobs/j1/runs" {
		t.Errorf("path = %q, want /apiv1/jobs/j1/runs", gotPath)
	}
	if gotLimit != "10" {
		t.Errorf("limit = %q, want 10", gotLimit)
	}
}

func TestJobRunsAllFollowsCursor(t *testing.T) {
	var cursors []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := r.URL.Query().Get("cursor")
		cursors = append(cursors, c)
		if c == "" {
			io.WriteString(w, `{"runs":[{"id":"r2","number":2,"status":"succeeded"}],"nextCursor":"r2"}`)
			return
		}
		io.WriteString(w, `{"runs":[{"id":"r1","number":1,"status":"failed"}],"nextCursor":null}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job", "runs", "j1", "--all"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job runs --all: %v", err)
	}
	if len(cursors) != 2 || cursors[0] != "" || cursors[1] != "r2" {
		t.Errorf("cursors = %v, want [\"\", \"r2\"]", cursors)
	}
}

func TestJobRunGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"r1","jobName":"nightly","number":4,"status":"failed","trigger":"manual","steps":[{"stepOrder":1,"name":"refresh","status":"failed","exitCode":1,"reason":"Error"}]}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job-run", "get", "r1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job-run get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/job-runs/r1" {
		t.Errorf("request = %s %s, want GET /apiv1/job-runs/r1", gotMethod, gotPath)
	}
}

func TestJobRunCancel(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"r1","status":"canceled"}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job-run", "cancel", "r1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job-run cancel: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/job-runs/r1/cancel" {
		t.Errorf("request = %s %s, want POST /apiv1/job-runs/r1/cancel", gotMethod, gotPath)
	}
}

func TestJobRunCancelRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job-run", "cancel", "r1"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestJobRunLogsSingleStep(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"logs":"hello\n","truncated":false,"live":false}`)
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job-run", "logs", "r1", "--step", "2"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job-run logs --step: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/job-runs/r1/steps/2/logs" {
		t.Errorf("request = %s %s, want GET /apiv1/job-runs/r1/steps/2/logs", gotMethod, gotPath)
	}
}

func TestJobRunLogsAllStepsInOrder(t *testing.T) {
	var logPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/job-runs/r1":
			io.WriteString(w, `{"id":"r1","steps":[{"stepOrder":1,"name":"a","status":"succeeded"},{"stepOrder":2,"name":"b","status":"failed"}]}`)
		case "/apiv1/job-runs/r1/steps/1/logs", "/apiv1/job-runs/r1/steps/2/logs":
			logPaths = append(logPaths, r.URL.Path)
			io.WriteString(w, `{"logs":"out\n","truncated":false,"live":false}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := jobTestRoot(t, srv.URL)
	root.SetArgs([]string{"job-run", "logs", "r1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("job-run logs: %v", err)
	}
	want := []string{"/apiv1/job-runs/r1/steps/1/logs", "/apiv1/job-runs/r1/steps/2/logs"}
	if len(logPaths) != 2 || logPaths[0] != want[0] || logPaths[1] != want[1] {
		t.Errorf("log paths = %v, want %v", logPaths, want)
	}
}
