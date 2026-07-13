package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

type composeCall struct {
	method string
	path   string
	body   map[string]any
}

// composeTestServer records every request and replies from the routes map
// (keyed "METHOD /apiv1/path"); unknown routes get a 404.
func composeTestServer(t *testing.T, routes map[string]string) (*httptest.Server, *[]composeCall) {
	t.Helper()
	calls := &[]composeCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		*calls = append(*calls, composeCall{r.Method, r.URL.Path, body})
		res, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, res)
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func runCompose(t *testing.T, srv *httptest.Server, args ...string) error {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	// silence the JSON the commands print for non-TTY stdout
	origStdout := os.Stdout
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open devnull: %v", err)
	}
	os.Stdout = devnull
	t.Cleanup(func() { os.Stdout = origStdout; devnull.Close() })

	root := rootCmd()
	registered := false
	for _, c := range root.Commands() {
		if c.Name() == "compose" {
			registered = true
		}
	}
	if !registered {
		root.AddCommand(composeCmd())
	}
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.ExecuteContext(t.Context())
}

func composeCallSigs(calls []composeCall) []string {
	sigs := []string{}
	for _, c := range calls {
		sigs = append(sigs, c.method+" "+c.path)
	}
	return sigs
}

func TestComposeListProjectScope(t *testing.T) {
	srv, calls := composeTestServer(t, map[string]string{
		"GET /apiv1/projects/p1": `{"id":"p1"}`,
		"GET /apiv1/projects/p1/compose-stacks": `[
			{"id":"cs1","name":"my-stack","status":"active","githubRepo":"https://github.com/leafd/app",
			 "githubBranch":"main","autoDeployEnabled":true,
			 "deployments":[{"id":"d1","name":"my-stack-web","status":"running","composeServiceName":"web"}]}
		]`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runCompose(t, srv, "compose", "list"); err != nil {
		t.Fatalf("compose list: %v", err)
	}
	// requireProject tries the slug lookup (404) before the id lookup.
	want := []string{"GET /apiv1/projects/slug/p1", "GET /apiv1/projects/p1", "GET /apiv1/projects/p1/compose-stacks"}
	if got := composeCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestComposeListRequiresProject(t *testing.T) {
	srv, calls := composeTestServer(t, nil)
	if err := runCompose(t, srv, "compose", "list"); err == nil {
		t.Fatal("expected an error without project scope")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", composeCallSigs(*calls))
	}
}

func TestComposeGet(t *testing.T) {
	srv, calls := composeTestServer(t, map[string]string{
		"GET /apiv1/compose-stacks/cs1": `{
			"id":"cs1","name":"my-stack","status":"active","githubRepo":"https://github.com/leafd/app",
			"githubBranch":"main","composePath":"docker-compose.yml","autoDeployEnabled":false,
			"buildStatus":"none","createdAt":"2026-07-12T00:00:00Z",
			"deployments":[
				{"id":"d1","name":"my-stack-web","status":"running","image":"nginx:latest","replicas":1,"composeServiceName":"web"},
				{"id":"d2","name":"my-stack-db","status":"running","image":"postgres:16","replicas":1,"composeServiceName":"db"}
			]
		}`,
	})
	if err := runCompose(t, srv, "compose", "get", "cs1"); err != nil {
		t.Fatalf("compose get: %v", err)
	}
	want := []string{"GET /apiv1/compose-stacks/cs1"}
	if got := composeCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestComposeDeployBody(t *testing.T) {
	srv, calls := composeTestServer(t, map[string]string{
		"GET /apiv1/projects/p1": `{"id":"p1"}`,
		"POST /apiv1/projects/p1/compose-stacks/from-github": `{
			"id":"cs9","name":"my-stack","status":"active",
			"deployments":[{"id":"d1","composeServiceName":"web"}]
		}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	err := runCompose(t, srv, "compose", "deploy",
		"--name", "my-stack", "--github", "leafd/app#dev",
		"--path", "deploy/compose.yml", "--auto-deploy")
	if err != nil {
		t.Fatalf("compose deploy: %v", err)
	}
	sigs := composeCallSigs(*calls)
	if sigs[len(sigs)-1] != "POST /apiv1/projects/p1/compose-stacks/from-github" {
		t.Fatalf("calls = %v", sigs)
	}
	body := (*calls)[len(*calls)-1].body
	if body["name"] != "my-stack" {
		t.Errorf("name = %v", body["name"])
	}
	if body["repoUrl"] != "https://github.com/leafd/app" {
		t.Errorf("repoUrl = %v", body["repoUrl"])
	}
	if body["branch"] != "dev" {
		t.Errorf("branch = %v", body["branch"])
	}
	if body["composePath"] != "deploy/compose.yml" {
		t.Errorf("composePath = %v", body["composePath"])
	}
	if body["autoDeployEnabled"] != true {
		t.Errorf("autoDeployEnabled = %v, want true", body["autoDeployEnabled"])
	}
}

func TestComposeDeployDefaults(t *testing.T) {
	srv, calls := composeTestServer(t, map[string]string{
		"GET /apiv1/projects/p1":                             `{"id":"p1"}`,
		"POST /apiv1/projects/p1/compose-stacks/from-github": `{"id":"cs9","name":"my-stack","status":"active","deployments":[]}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runCompose(t, srv, "compose", "deploy", "--name", "my-stack", "--github", "https://github.com/leafd/app"); err != nil {
		t.Fatalf("compose deploy: %v", err)
	}
	body := (*calls)[len(*calls)-1].body
	if body["repoUrl"] != "https://github.com/leafd/app" {
		t.Errorf("repoUrl = %v, want the URL passed through", body["repoUrl"])
	}
	if _, ok := body["branch"]; ok {
		t.Errorf("branch should be omitted when no #branch is given, got %v", body["branch"])
	}
	if body["composePath"] != "docker-compose.yml" {
		t.Errorf("composePath = %v, want the docker-compose.yml default", body["composePath"])
	}
	if body["autoDeployEnabled"] != false {
		t.Errorf("autoDeployEnabled = %v, want false", body["autoDeployEnabled"])
	}
}

func TestComposeDeployRejectsBadRepo(t *testing.T) {
	srv, calls := composeTestServer(t, nil)
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runCompose(t, srv, "compose", "deploy", "--name", "x", "--github", "justname"); err == nil {
		t.Fatal("expected an error for a repo without owner/")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", composeCallSigs(*calls))
	}
}

func TestComposeRedeploy(t *testing.T) {
	srv, calls := composeTestServer(t, map[string]string{
		"POST /apiv1/compose-stacks/cs1/redeploy": `{"id":"cs1","status":"active","deployments":[]}`,
	})
	if err := runCompose(t, srv, "compose", "redeploy", "cs1"); err != nil {
		t.Fatalf("compose redeploy: %v", err)
	}
	want := []string{"POST /apiv1/compose-stacks/cs1/redeploy"}
	if got := composeCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestComposeAutoDeployToggle(t *testing.T) {
	tests := []struct {
		verb string
		want bool
	}{
		{"enable", true},
		{"disable", false},
	}
	for _, tt := range tests {
		t.Run(tt.verb, func(t *testing.T) {
			srv, calls := composeTestServer(t, map[string]string{
				"PUT /apiv1/compose-stacks/cs1/auto-deploy": `{"id":"cs1"}`,
			})
			if err := runCompose(t, srv, "compose", "auto-deploy", tt.verb, "cs1"); err != nil {
				t.Fatalf("compose auto-deploy %s: %v", tt.verb, err)
			}
			want := []string{"PUT /apiv1/compose-stacks/cs1/auto-deploy"}
			if got := composeCallSigs(*calls); !reflect.DeepEqual(got, want) {
				t.Fatalf("calls = %v, want %v", got, want)
			}
			if body := (*calls)[0].body; body["enabled"] != tt.want {
				t.Errorf("enabled = %v, want %v", body["enabled"], tt.want)
			}
		})
	}
}

func TestComposeDelete(t *testing.T) {
	srv, calls := composeTestServer(t, map[string]string{
		"DELETE /apiv1/compose-stacks/cs1": `{"success":true}`,
	})
	if err := runCompose(t, srv, "compose", "delete", "cs1", "--yes"); err != nil {
		t.Fatalf("compose delete: %v", err)
	}
	want := []string{"DELETE /apiv1/compose-stacks/cs1"}
	if got := composeCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestComposeDeleteRefusesWithoutYes(t *testing.T) {
	srv, calls := composeTestServer(t, nil)
	if err := runCompose(t, srv, "compose", "delete", "cs1"); err == nil {
		t.Fatal("expected the non-TTY confirm to refuse")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", composeCallSigs(*calls))
	}
}
