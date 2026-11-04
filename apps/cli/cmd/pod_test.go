package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/spf13/cobra"
)

// podTestRoot wires podCmd under a real root so persistent flags (--project,
// --yes, -o) behave exactly as in production, with config isolated to a temp
// HOME and the API pointed at the given httptest server.
func podTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	root.AddCommand(podCmd())
	return root
}

func TestPodListExplicitNamespace(t *testing.T) {
	var gotPath, gotNS string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotNS = r.URL.Query().Get("namespace")
		io.WriteString(w, `{"namespace":"custom","podCount":1,"pods":[{"name":"web-1","status":"Running"}]}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "list", "--namespace", "custom"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod list: %v", err)
	}
	if gotPath != "/apiv1/pods" {
		t.Errorf("path = %q, want /apiv1/pods", gotPath)
	}
	if gotNS != "custom" {
		t.Errorf("namespace = %q, want custom", gotNS)
	}
}

func TestPodListResolvesProjectNamespace(t *testing.T) {
	var podsNS string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/projects/slug/myproj":
			io.WriteString(w, `{"id":"p1","slug":"myproj","namespace":"ns-from-proj"}`)
		case "/apiv1/pods":
			podsNS = r.URL.Query().Get("namespace")
			io.WriteString(w, `{"namespace":"ns-from-proj","podCount":0,"pods":[]}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "list", "--project", "myproj"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod list: %v", err)
	}
	if podsNS != "ns-from-proj" {
		t.Errorf("namespace = %q, want ns-from-proj", podsNS)
	}
}

func TestPodListNoScopeErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "list"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--namespace") {
		t.Fatalf("want a namespace-scope error, got %v", err)
	}
}

func TestPodGet(t *testing.T) {
	var gotMethod, gotPath, gotNS string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotNS = r.URL.Query().Get("namespace")
		io.WriteString(w, `{"metadata":{"name":"web-1","namespace":"ns1"},"spec":{"nodeName":"node-a"},"status":{"phase":"Running","containerStatuses":[{"name":"web","ready":true,"restartCount":2,"state":{"running":{}}}]}}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "get", "web-1", "-n", "ns1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/pods/web-1" {
		t.Errorf("request = %s %s, want GET /apiv1/pods/web-1", gotMethod, gotPath)
	}
	if gotNS != "ns1" {
		t.Errorf("namespace = %q, want ns1", gotNS)
	}
}

func TestPodLogsQueryParams(t *testing.T) {
	var gotPath string
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		io.WriteString(w, `{"podName":"web-1","container":"web","logs":"hello\n"}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "logs", "web-1", "-n", "ns1", "-c", "web", "--tail", "55", "--previous"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod logs: %v", err)
	}
	if gotPath != "/apiv1/pods/web-1/logs" {
		t.Errorf("path = %q, want /apiv1/pods/web-1/logs", gotPath)
	}
	for k, want := range map[string]string{
		"namespace": "ns1",
		"container": "web",
		"tailLines": "55",
		"previous":  "true",
	} {
		if got := gotQuery[k]; len(got) != 1 || got[0] != want {
			t.Errorf("query %s = %v, want %q", k, got, want)
		}
	}
}

func TestPodDelete(t *testing.T) {
	var gotMethod, gotPath, gotNS string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotNS = r.URL.Query().Get("namespace")
		io.WriteString(w, `{"success":true,"message":"Pod web-1 deleted"}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "delete", "web-1", "-n", "ns1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/pods/web-1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/pods/web-1", gotMethod, gotPath)
	}
	if gotNS != "ns1" {
		t.Errorf("namespace = %q, want ns1", gotNS)
	}
}

func TestPodDeleteRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "delete", "web-1", "-n", "ns1"})
	err := root.Execute()
	if err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if exitcode.FromError(err) != exitcode.Usage {
		t.Errorf("exit code = %d, want %d (usage)", exitcode.FromError(err), exitcode.Usage)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestPodExecBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		io.WriteString(w, `{"stdout":"total 0\n","stderr":"","success":true,"container":"web"}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "exec", "web-1", "-n", "ns1", "-c", "web", "--", "ls", "-la"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod exec: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/pods/web-1/exec" {
		t.Errorf("request = %s %s, want POST /apiv1/pods/web-1/exec", gotMethod, gotPath)
	}
	if gotBody["namespace"] != "ns1" || gotBody["container"] != "web" {
		t.Errorf("body scope = %v/%v, want ns1/web", gotBody["namespace"], gotBody["container"])
	}
	cmdArg, _ := gotBody["command"].([]any)
	if len(cmdArg) != 2 || cmdArg[0] != "ls" || cmdArg[1] != "-la" {
		t.Errorf("body command = %v, want [ls -la]", gotBody["command"])
	}
}

func TestPodExecForbiddenMentionsScope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"message":"Insufficient scope: exec required"}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "exec", "web-1", "-n", "ns1", "--", "id"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "'exec' scope") {
		t.Fatalf("want an exec-scope hint in the error, got %v", err)
	}
	if exitcode.FromError(err) != exitcode.Invalid {
		t.Errorf("exit code = %d, want %d (the 403 must stay wrapped)", exitcode.FromError(err), exitcode.Invalid)
	}
}

func TestPodExecFailurePropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"stdout":"","stderr":"sh: nope: not found\n","success":false,"container":"web"}`)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "exec", "web-1", "-n", "ns1", "--", "nope"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "command failed") {
		t.Fatalf("want a command-failed error, got %v", err)
	}
}

func TestPodShellRefusesNonTTY(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "shell", "web-1", "-n", "ns1"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "TTY") {
		t.Fatalf("want a non-TTY refusal, got %v", err)
	}
}

func TestPodListResolvesProjectSlugFromList(t *testing.T) {
	var podsNS string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/projects":
			io.WriteString(w, `[{"id":"p1","slug":"myproj","namespace":"ns-from-list"},{"id":"p2","slug":"other","namespace":"ns-other"}]`)
		case "/apiv1/pods":
			podsNS = r.URL.Query().Get("namespace")
			io.WriteString(w, `{"namespace":"ns-from-list","podCount":0,"pods":[]}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "list", "--project", "myproj"})
	if err := root.Execute(); err != nil {
		t.Fatalf("pod list: %v", err)
	}
	if podsNS != "ns-from-list" {
		t.Errorf("namespace = %q, want ns-from-list", podsNS)
	}
}

func TestProjectSlugInTwoOrgsAsksForID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/projects" {
			io.WriteString(w, `[{"id":"p1","slug":"myproj"},{"id":"p2","slug":"myproj"}]`)
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()

	root := podTestRoot(t, srv.URL)
	root.SetArgs([]string{"pod", "list", "--project", "myproj"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "use the project id") {
		t.Fatalf("err = %v, want a request for the project id", err)
	}
}
