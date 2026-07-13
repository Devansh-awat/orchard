package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type envReq struct {
	method, path, body string
}

// envTestServer serves the minimal Orchard surface env commands touch:
// project slug resolution, the environments list, and the shared-vars pair.
func envTestServer(t *testing.T, reqs *[]envReq) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*reqs = append(*reqs, envReq{r.Method, r.URL.Path, string(b)})
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/projects/slug/p1":
			io.WriteString(w, `{"id":"p1","slug":"p1"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/projects/p1/environments":
			io.WriteString(w, `[
				{"id":"e1","name":"Production","slug":"production","namespace":"org-p1","isDefault":true,"isProduction":true,"_count":{"deployments":2,"databases":1,"ingresses":0}},
				{"id":"e2","name":"Staging","slug":"staging","namespace":"org-p1-staging","isDefault":false,"isProduction":false,"_count":{"deployments":0,"databases":0,"ingresses":0}}
			]`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/environments":
			io.WriteString(w, `{"id":"e3","name":"QA","slug":"qa","namespace":"org-p1-qa"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/environments/e2/shared-vars":
			io.WriteString(w, `[{"key":"API_KEY","value":null,"secret":true},{"key":"PLAIN","value":"1","secret":false}]`)
		case r.Method == http.MethodPut && r.URL.Path == "/apiv1/environments/e2/shared-vars":
			io.WriteString(w, `{"vars":[],"warnings":[{"key":"PLAIN","missingRef":"GONE"}]}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/apiv1/environments/e2":
			io.WriteString(w, `{"success":true}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/environments/e2/set-default":
			io.WriteString(w, `{"id":"e2","isDefault":true}`)
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"message":"not found"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// envTestSetup points client() at the test server and pins the scope globals
// so a developer's real config/env can't leak in.
func envTestSetup(t *testing.T, srvURL string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_PROJECT", "p1")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_ENV", "")
	origYes, origOut := yesFlag, outputFlag
	origOrg, origProj, origEnv := orgFlag, projectFlag, envFlag
	orgFlag, projectFlag, envFlag = "", "", ""
	t.Cleanup(func() {
		yesFlag, outputFlag = origYes, origOut
		orgFlag, projectFlag, envFlag = origOrg, origProj, origEnv
	})
}

func envRun(t *testing.T, args ...string) error {
	t.Helper()
	c := envCmd()
	c.SetArgs(args)
	return c.Execute()
}

func envCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	fn()
	w.Close()
	os.Stdout = orig
	b, _ := io.ReadAll(r)
	return string(b)
}

func envFindReq(reqs []envReq, method, path string) *envReq {
	for i := range reqs {
		if reqs[i].method == method && reqs[i].path == path {
			return &reqs[i]
		}
	}
	return nil
}

func TestEnvListMarksDefault(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	outputFlag = "table"

	out := envCaptureStdout(t, func() {
		if err := envRun(t, "list"); err != nil {
			t.Errorf("env list: %v", err)
		}
	})
	if envFindReq(reqs, http.MethodGet, "/apiv1/projects/p1/environments") == nil {
		t.Fatalf("server never saw GET /projects/p1/environments, got %v", reqs)
	}
	prodLine := ""
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "Production") {
			prodLine = line
		}
		if strings.Contains(line, "Staging") && strings.Contains(line, "✓") {
			t.Errorf("non-default env marked as default: %q", line)
		}
	}
	if !strings.Contains(prodLine, "✓") {
		t.Errorf("default env not marked, line = %q", prodLine)
	}
}

func TestEnvGetResolvesByName(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	outputFlag = "json"

	out := envCaptureStdout(t, func() {
		if err := envRun(t, "get", "staging"); err != nil {
			t.Errorf("env get: %v", err)
		}
	})
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("output not json: %v\n%s", err, out)
	}
	if m["id"] != "e2" {
		t.Errorf("resolved id = %v, want e2", m["id"])
	}
}

func TestEnvCreateBody(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)

	if err := envRun(t, "create", "--name", "QA"); err != nil {
		t.Fatalf("env create: %v", err)
	}
	req := envFindReq(reqs, http.MethodPost, "/apiv1/projects/p1/environments")
	if req == nil {
		t.Fatalf("no POST /projects/p1/environments, got %v", reqs)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(req.body), &body); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if body["name"] != "QA" {
		t.Errorf("body name = %v, want QA", body["name"])
	}
	if _, ok := body["slug"]; ok {
		t.Errorf("slug should be omitted when not passed, body = %v", body)
	}
}

func TestEnvDelete(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	yesFlag = true

	if err := envRun(t, "delete", "staging"); err != nil {
		t.Fatalf("env delete: %v", err)
	}
	if envFindReq(reqs, http.MethodDelete, "/apiv1/environments/e2") == nil {
		t.Fatalf("no DELETE /environments/e2, got %v", reqs)
	}
}

func TestEnvDeleteRefusesWithoutYes(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	yesFlag = false

	if err := envRun(t, "delete", "staging"); err == nil {
		t.Fatal("expected confirmation refusal, got nil")
	}
	if envFindReq(reqs, http.MethodDelete, "/apiv1/environments/e2") != nil {
		t.Fatal("DELETE issued despite refused confirmation")
	}
}

func TestEnvSetDefault(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)

	if err := envRun(t, "set-default", "staging"); err != nil {
		t.Fatalf("env set-default: %v", err)
	}
	if envFindReq(reqs, http.MethodPost, "/apiv1/environments/e2/set-default") == nil {
		t.Fatalf("no POST /environments/e2/set-default, got %v", reqs)
	}
}

func TestEnvVarsGetMasksSecrets(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	outputFlag = "table"

	out := envCaptureStdout(t, func() {
		if err := envRun(t, "vars", "get", "staging"); err != nil {
			t.Errorf("env vars get: %v", err)
		}
	})
	if envFindReq(reqs, http.MethodGet, "/apiv1/environments/e2/shared-vars") == nil {
		t.Fatalf("no GET /environments/e2/shared-vars, got %v", reqs)
	}
	if !strings.Contains(out, "(write-only)") {
		t.Errorf("secret value not masked:\n%s", out)
	}
	if !strings.Contains(out, "PLAIN") || !strings.Contains(out, "1") {
		t.Errorf("plain var missing:\n%s", out)
	}
}

func TestEnvVarsGetScopedEnv(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	t.Setenv("ORCHARD_ENV", "staging")

	if err := envRun(t, "vars", "get"); err != nil {
		t.Fatalf("env vars get: %v", err)
	}
	if envFindReq(reqs, http.MethodGet, "/apiv1/environments/e2/shared-vars") == nil {
		t.Fatalf("scoped env not resolved, requests = %v", reqs)
	}
}

func TestEnvVarsSetMergesAndPuts(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	t.Setenv("ORCHARD_ENV", "staging")

	if err := envRun(t, "vars", "set", "NEW=x", "--secret"); err != nil {
		t.Fatalf("env vars set: %v", err)
	}
	req := envFindReq(reqs, http.MethodPut, "/apiv1/environments/e2/shared-vars")
	if req == nil {
		t.Fatalf("no PUT /environments/e2/shared-vars, got %v", reqs)
	}
	var body struct {
		Vars []struct {
			Key    string  `json:"key"`
			Value  *string `json:"value"`
			Secret bool    `json:"secret"`
		} `json:"vars"`
	}
	if err := json.Unmarshal([]byte(req.body), &body); err != nil {
		t.Fatalf("body not json: %v\n%s", err, req.body)
	}
	if len(body.Vars) != 3 {
		t.Fatalf("vars len = %d, want 3 (body %s)", len(body.Vars), req.body)
	}
	// payload is sorted by key: API_KEY, NEW, PLAIN
	if body.Vars[0].Key != "API_KEY" || body.Vars[0].Value != nil || !body.Vars[0].Secret {
		t.Errorf("untouched secret not carried as write-only null: %+v", body.Vars[0])
	}
	if body.Vars[1].Key != "NEW" || body.Vars[1].Value == nil || *body.Vars[1].Value != "x" || !body.Vars[1].Secret {
		t.Errorf("new secret var wrong: %+v", body.Vars[1])
	}
	if body.Vars[2].Key != "PLAIN" || body.Vars[2].Value == nil || *body.Vars[2].Value != "1" || body.Vars[2].Secret {
		t.Errorf("untouched plain var changed: %+v", body.Vars[2])
	}
}

func TestEnvVarsSetPreservesSecretFlag(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	t.Setenv("ORCHARD_ENV", "staging")

	if err := envRun(t, "vars", "set", "API_KEY=rotated"); err != nil {
		t.Fatalf("env vars set: %v", err)
	}
	req := envFindReq(reqs, http.MethodPut, "/apiv1/environments/e2/shared-vars")
	if req == nil {
		t.Fatalf("no PUT, got %v", reqs)
	}
	var body map[string][]map[string]any
	if err := json.Unmarshal([]byte(req.body), &body); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	for _, v := range body["vars"] {
		if v["key"] == "API_KEY" {
			if v["value"] != "rotated" || v["secret"] != true {
				t.Errorf("existing secret flag not preserved on update: %v", v)
			}
			return
		}
	}
	t.Fatalf("API_KEY missing from payload: %s", req.body)
}

func TestEnvVarsUnset(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	t.Setenv("ORCHARD_ENV", "staging")
	yesFlag = true

	if err := envRun(t, "vars", "unset", "PLAIN"); err != nil {
		t.Fatalf("env vars unset: %v", err)
	}
	req := envFindReq(reqs, http.MethodPut, "/apiv1/environments/e2/shared-vars")
	if req == nil {
		t.Fatalf("no PUT, got %v", reqs)
	}
	var body map[string][]map[string]any
	if err := json.Unmarshal([]byte(req.body), &body); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if len(body["vars"]) != 1 || body["vars"][0]["key"] != "API_KEY" {
		t.Errorf("payload should keep only API_KEY: %s", req.body)
	}
}

func TestEnvVarsUnsetUnknownKey(t *testing.T) {
	var reqs []envReq
	srv := envTestServer(t, &reqs)
	envTestSetup(t, srv.URL)
	t.Setenv("ORCHARD_ENV", "staging")
	yesFlag = true

	err := envRun(t, "vars", "unset", "NOPE")
	if err == nil || !strings.Contains(err.Error(), "not set") {
		t.Fatalf("want unknown-key error, got %v", err)
	}
	if envFindReq(reqs, http.MethodPut, "/apiv1/environments/e2/shared-vars") != nil {
		t.Fatal("PUT issued for unknown key")
	}
}
