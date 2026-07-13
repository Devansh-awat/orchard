package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"testing"
)

type githubCall struct {
	method string
	path   string
	query  url.Values
	body   map[string]any
}

// githubTestServer records every request and replies from the routes map
// (keyed "METHOD /apiv1/path"); unknown routes get a 404.
func githubTestServer(t *testing.T, routes map[string]string) (*httptest.Server, *[]githubCall) {
	t.Helper()
	calls := &[]githubCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		*calls = append(*calls, githubCall{r.Method, r.URL.Path, r.URL.Query(), body})
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

func runGithub(t *testing.T, srv *httptest.Server, args ...string) error {
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
		if c.Name() == "github" {
			registered = true
		}
	}
	if !registered {
		root.AddCommand(githubCmd())
	}
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.ExecuteContext(t.Context())
}

func githubCallSigs(calls []githubCall) []string {
	sigs := []string{}
	for _, c := range calls {
		sigs = append(sigs, c.method+" "+c.path)
	}
	return sigs
}

func TestGithubStatus(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/status": `{"linked":true,"username":"leafd","tokenExpired":false,"installations":[{"id":"i1"}]}`,
	})
	if err := runGithub(t, srv, "github", "status"); err != nil {
		t.Fatalf("github status: %v", err)
	}
	want := []string{"GET /apiv1/github/status"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestGithubInstallations(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/app/installations": `[{"id":"x","installationId":"123","accountLogin":"leafd","accountType":"User","repositorySelection":"all"}]`,
	})
	if err := runGithub(t, srv, "github", "installations"); err != nil {
		t.Fatalf("github installations: %v", err)
	}
	want := []string{"GET /apiv1/github/app/installations"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestGithubInstall(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/app/install": `{"url":"https://github.com/apps/orchard/installations/new"}`,
	})
	if err := runGithub(t, srv, "github", "install"); err != nil {
		t.Fatalf("github install: %v", err)
	}
	want := []string{"GET /apiv1/github/app/install"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestGithubRepos(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories": `{"repositories":[{"name":"r","full_name":"o/r","private":false,"default_branch":"main"}],"installations":[],"source":"app"}`,
	})
	if err := runGithub(t, srv, "github", "repos"); err != nil {
		t.Fatalf("github repos: %v", err)
	}
	want := []string{"GET /apiv1/github/repositories"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
	if q := (*calls)[0].query.Get("all"); q != "" {
		t.Errorf("all query = %q, want empty without --all", q)
	}
}

func TestGithubReposAll(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories": `{"repositories":[],"installations":[],"source":"oauth"}`,
	})
	if err := runGithub(t, srv, "github", "repos", "--all"); err != nil {
		t.Fatalf("github repos --all: %v", err)
	}
	if q := (*calls)[0].query.Get("all"); q != "true" {
		t.Errorf("all query = %q, want true", q)
	}
}

func TestGithubBranches(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories/leafd/site/branches": `[{"name":"main","commit":{"sha":"abc1234def"}}]`,
	})
	if err := runGithub(t, srv, "github", "branches", "leafd/site"); err != nil {
		t.Fatalf("github branches: %v", err)
	}
	want := []string{"GET /apiv1/github/repositories/leafd/site/branches"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestGithubBranchesRejectsBadRepo(t *testing.T) {
	srv, calls := githubTestServer(t, nil)
	if err := runGithub(t, srv, "github", "branches", "nope"); err == nil {
		t.Fatal("expected an owner/repo parse error")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", githubCallSigs(*calls))
	}
}

func TestGithubDockerfilesBranchQuery(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories/o/r/dockerfiles": `["Dockerfile","apps/api/Dockerfile"]`,
	})
	if err := runGithub(t, srv, "github", "dockerfiles", "o/r", "--branch", "dev"); err != nil {
		t.Fatalf("github dockerfiles: %v", err)
	}
	want := []string{"GET /apiv1/github/repositories/o/r/dockerfiles"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if q := (*calls)[0].query.Get("branch"); q != "dev" {
		t.Errorf("branch query = %q, want dev", q)
	}
}

func TestGithubDockerfileInfoQuery(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories/o/r/dockerfile-info": `{"exposedPorts":[3000],"envVars":[{"key":"NODE_ENV","value":"production"}],"stages":["base","build"]}`,
	})
	if err := runGithub(t, srv, "github", "dockerfile-info", "o/r", "apps/api/Dockerfile", "--branch", "main"); err != nil {
		t.Fatalf("github dockerfile-info: %v", err)
	}
	want := []string{"GET /apiv1/github/repositories/o/r/dockerfile-info"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	q := (*calls)[0].query
	if q.Get("dockerfilePath") != "apps/api/Dockerfile" {
		t.Errorf("dockerfilePath = %q, want apps/api/Dockerfile", q.Get("dockerfilePath"))
	}
	if q.Get("branch") != "main" {
		t.Errorf("branch = %q, want main", q.Get("branch"))
	}
}

func TestGithubContentsPathQuery(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories/o/r/contents": `[{"name":"cli","path":"apps/cli","type":"dir","size":0}]`,
	})
	if err := runGithub(t, srv, "github", "contents", "o/r", "apps"); err != nil {
		t.Fatalf("github contents: %v", err)
	}
	want := []string{"GET /apiv1/github/repositories/o/r/contents"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if q := (*calls)[0].query.Get("path"); q != "apps" {
		t.Errorf("path query = %q, want apps", q)
	}
}

func TestGithubContentsRootOmitsPath(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/github/repositories/o/r/contents": `[]`,
	})
	if err := runGithub(t, srv, "github", "contents", "o/r"); err != nil {
		t.Fatalf("github contents: %v", err)
	}
	if q := (*calls)[0].query.Get("path"); q != "" {
		t.Errorf("path query = %q, want empty", q)
	}
}

func TestGithubLinkMakesNoAPICall(t *testing.T) {
	srv, calls := githubTestServer(t, nil)
	if err := runGithub(t, srv, "github", "link"); err != nil {
		t.Fatalf("github link: %v", err)
	}
	if len(*calls) != 0 {
		t.Errorf("link must not call the API with the CLI token, got %v", githubCallSigs(*calls))
	}
}

func TestGithubLinkURL(t *testing.T) {
	if got := githubLinkURL("https://orchard.example.com/"); got != "https://orchard.example.com/apiv1/github/link" {
		t.Errorf("githubLinkURL = %q", got)
	}
}

func TestGithubUnlink(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"DELETE /apiv1/github/unlink": `{"success":true,"message":"GitHub account unlinked successfully"}`,
	})
	if err := runGithub(t, srv, "github", "unlink", "--yes"); err != nil {
		t.Fatalf("github unlink: %v", err)
	}
	want := []string{"DELETE /apiv1/github/unlink"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestGithubUnlinkRefusesWithoutYes(t *testing.T) {
	srv, calls := githubTestServer(t, nil)
	if err := runGithub(t, srv, "github", "unlink"); err == nil {
		t.Fatal("expected the non-TTY confirm to refuse")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", githubCallSigs(*calls))
	}
}
