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

	"github.com/hackclub/orchard/cli/internal/agentspec"
)

func startSpecAPI(t *testing.T, routes map[string]string) *recorder {
	t.Helper()
	spec, _ := json.Marshal(agentspec.Spec{Version: "t", Operations: []agentspec.Operation{
		{OperationID: "deployments_get", Method: "GET", Path: "/deployments/:id", Summary: "Get a deployment", Tags: []string{"deployments"}, Scope: "read"},
		{OperationID: "deployments_restart", Method: "POST", Path: "/deployments/:id/restart", Summary: "Restart a deployment", Tags: []string{"deployments"}, Scope: "deploy"},
		{OperationID: "deployments_rollout_get", Method: "GET", Path: "/deployments/:id/rollout", Summary: "Rollout status", Tags: []string{"deployments"}, Scope: "read",
			Params: &agentspec.Params{Path: []agentspec.Param{{Name: "id", Required: true}}, Query: []agentspec.Param{{Name: "wait"}}}},
		{OperationID: "databases_delete", Method: "DELETE", Path: "/databases/:id", Tags: []string{"databases"}, Scope: "deploy", Destructive: true},
	}})
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.add(r, body)
		if r.URL.Path == "/apiv1/agent-spec.json" {
			w.Header().Set("ETag", `"t"`)
			w.Write(spec)
			return
		}
		if res, ok := routes[r.Method+" "+r.URL.Path]; ok {
			io.WriteString(w, res)
			return
		}
		w.WriteHeader(404)
		io.WriteString(w, `{"message":"not found"}`)
	}))
	t.Cleanup(srv.Close)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORCHARD_SPEC_CACHE_DIR", filepath.Join(home, ".orchard"))
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_JSON", "1")
	return rec
}

func TestAPICallByOperationIDFillsPathAndQuery(t *testing.T) {
	rec := startSpecAPI(t, map[string]string{"GET /apiv1/deployments/a b/rollout": `{"phase":"live"}`})
	out := captureStdout(t, func() {
		if err := runCLI(t, "api", "deployments_rollout_get", "-p", "id=a b", "-q", "wait=1", "-q", "timeout=60"); err != nil {
			t.Fatalf("api: %v", err)
		}
	})
	req, ok := rec.find("GET", "/apiv1/deployments/a b/rollout")
	if !ok {
		t.Fatalf("rollout never hit: %+v", rec.reqs)
	}
	if req.Query != "timeout=60&wait=1" {
		t.Errorf("query = %q", req.Query)
	}
	if !strings.Contains(out, `"phase": "live"`) {
		t.Errorf("stdout = %q", out)
	}
	if cached, _ := filepath.Glob(filepath.Join(os.Getenv("ORCHARD_SPEC_CACHE_DIR"), "agent-spec.*.json")); len(cached) != 1 {
		t.Errorf("spec was not cached per instance: %v", cached)
	}
}

func TestAPICallSendsBodyFromFile(t *testing.T) {
	rec := startSpecAPI(t, map[string]string{"POST /apiv1/deployments/d1/restart": `{}`})
	file := filepath.Join(t.TempDir(), "body.json")
	os.WriteFile(file, []byte(`{"force":true}`), 0o600)
	captureStdout(t, func() {
		if err := runCLI(t, "api", "deployments_restart", "-p", "id=d1", "-d", "@"+file); err != nil {
			t.Fatalf("api: %v", err)
		}
	})
	req, _ := rec.find("POST", "/apiv1/deployments/d1/restart")
	if string(req.Body) != `{"force":true}` {
		t.Errorf("body = %q", req.Body)
	}
}

func TestAPICallRejectsMissingAndUnknownParams(t *testing.T) {
	startSpecAPI(t, nil)
	if err := runCLI(t, "api", "deployments_get"); err == nil || !strings.Contains(err.Error(), "-p id=") {
		t.Errorf("missing param error = %v", err)
	}
	if err := runCLI(t, "api", "deployments_get", "-p", "id=1", "-p", "nope=2"); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Errorf("unknown param error = %v", err)
	}
	if err := runCLI(t, "api", "no_such_operation"); err == nil || !strings.Contains(err.Error(), "api search") {
		t.Errorf("unknown op error = %v", err)
	}
}

func TestAPIDestructiveOperationNeedsYesOffTTY(t *testing.T) {
	rec := startSpecAPI(t, map[string]string{"DELETE /apiv1/databases/x": `{}`})
	if err := runCLI(t, "api", "databases_delete", "-p", "id=x"); err == nil {
		t.Fatal("destructive call ran without --yes")
	}
	if _, ok := rec.find("DELETE", "/apiv1/databases/x"); ok {
		t.Fatal("request was sent before confirmation")
	}
	captureStdout(t, func() {
		if err := runCLI(t, "api", "databases_delete", "-p", "id=x", "--yes"); err != nil {
			t.Fatalf("with --yes: %v", err)
		}
	})
	yesFlag = false
	if _, ok := rec.find("DELETE", "/apiv1/databases/x"); !ok {
		t.Fatal("confirmed delete never reached the API")
	}
}

func TestAPILegacyMethodPathStillWorks(t *testing.T) {
	rec := startSpecAPI(t, map[string]string{"GET /apiv1/projects": `[]`})
	captureStdout(t, func() {
		if err := runCLI(t, "api", "GET", "/projects"); err != nil {
			t.Fatalf("legacy: %v", err)
		}
	})
	if _, ok := rec.find("GET", "/apiv1/projects"); !ok {
		t.Fatal("legacy GET /projects never hit")
	}
	if _, ok := rec.find("GET", "/apiv1/agent-spec.json"); ok {
		t.Fatal("legacy form should not need the spec")
	}
}

func TestAPISearchAndDescribe(t *testing.T) {
	startSpecAPI(t, nil)
	out := captureStdout(t, func() {
		if err := runCLI(t, "api", "search", "restart", "my", "app"); err != nil {
			t.Fatalf("search: %v", err)
		}
	})
	var hits []agentspec.Hit
	if err := json.Unmarshal([]byte(out), &hits); err != nil || len(hits) == 0 {
		t.Fatalf("search output %q: %v", out, err)
	}
	if hits[0].OperationID != "deployments_restart" {
		t.Errorf("top hit = %s", hits[0].OperationID)
	}

	out = captureStdout(t, func() {
		if err := runCLI(t, "api", "describe", "GET", "/deployments/abc/rollout"); err != nil {
			t.Fatalf("describe: %v", err)
		}
	})
	var op agentspec.Operation
	if err := json.Unmarshal([]byte(out), &op); err != nil || op.OperationID != "deployments_rollout_get" {
		t.Fatalf("describe output %q: %v", out, err)
	}
}
