package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func sandboxTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	return greenhouseTestRoot(t, withGreenhouse(t, srvURL))
}

func withGreenhouse(t *testing.T, srvURL string) string {
	t.Helper()
	upstream, err := url.Parse(srvURL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/instance/features" {
			io.WriteString(w, `{"mcp":true,"grafts":["greenhouse"],"sandboxes":true}`)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(front.Close)
	return front.URL
}

func greenhouseTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	for _, c := range root.Commands() {
		if c.Name() == "sandbox" {
			return root
		}
	}
	root.AddCommand(sandboxCmd())
	return root
}

func sandboxDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

func sandboxCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(r)
		done <- string(data)
	}()
	defer func() {
		os.Stdout = old
	}()
	fn()
	w.Close()
	os.Stdout = old
	return <-done
}

const sandboxListJSON = `{"sandboxes":[{"id":"11111111-1111-1111-1111-111111111111","name":"box","status":"running","repoUrl":"https://github.com/o/r","sshIdentity":{"id":"id-1","name":"laptop"},"createdAt":"2026-08-01T00:00:00Z","lastActiveAt":"2026-08-02T00:00:00Z"}],"maxSandboxes":3}`

func TestSandboxCreateWithIdentity(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/ssh-identities":
			io.WriteString(w, `{"identities":[{"id":"id-1","name":"laptop","publicKey":"ssh-ed25519 AAAA me@host"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/sandboxes":
			gotBody = sandboxDecodeBody(t, r)
			io.WriteString(w, `{"id":"sb-1","name":"box","status":"creating"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "create", "box", "--repo", "https://github.com/o/r", "--identity", "laptop"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox create: %v", err)
	}
	if gotBody["name"] != "box" || gotBody["repoUrl"] != "https://github.com/o/r" {
		t.Errorf("name/repoUrl = %v/%v", gotBody["name"], gotBody["repoUrl"])
	}
	if gotBody["sshIdentityId"] != "id-1" {
		t.Errorf("sshIdentityId = %v, want the resolved identity id", gotBody["sshIdentityId"])
	}
}

func TestSandboxCreateWithoutIdentityOmitsField(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = sandboxDecodeBody(t, r)
		io.WriteString(w, `{"id":"sb-1","name":"box","status":"creating"}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "create", "box"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox create: %v", err)
	}
	if _, present := gotBody["sshIdentityId"]; present {
		t.Errorf("body = %v, want sshIdentityId omitted so the server auto-picks", gotBody)
	}
}

func TestSandboxCreateNoIdentitiesHint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, `{"message":"You have no SSH identities; add one in user settings"}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "create", "box"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "orchard ssh-identity add") || !strings.Contains(err.Error(), "import-github") {
		t.Fatalf("want the no-identities hint, got %v", err)
	}
}

func TestSandboxListTableAndFooter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/sandboxes" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list", "-o", "table"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox list: %v", err)
		}
	})
	for _, want := range []string{"NAME", "STATUS", "REPO", "IDENTITY", "CREATED", "LAST ACTIVE", "box", "laptop", "1 of 3 sandboxes used"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestSandboxListJSONEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list", "-o", "json"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox list -o json: %v", err)
		}
	})
	var raw map[string]any
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		t.Fatalf("json output: %v\n%s", err, out)
	}
	if raw["maxSandboxes"] != float64(3) {
		t.Errorf("maxSandboxes = %v, want the raw envelope with 3", raw["maxSandboxes"])
	}
	if _, ok := raw["sandboxes"].([]any); !ok {
		t.Errorf("sandboxes = %v, want the raw array", raw["sandboxes"])
	}
}

func TestSandboxResolveAmbiguousPrefix(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"sandboxes":[{"id":"aaa11111-1111-1111-1111-111111111111","name":"one","status":"running"},{"id":"aaa22222-2222-2222-2222-222222222222","name":"two","status":"stopped"}],"maxSandboxes":3}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "get", "aaa"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("want an ambiguity error listing candidates, got %v", err)
	}
	if !strings.Contains(err.Error(), "one") || !strings.Contains(err.Error(), "two") {
		t.Errorf("ambiguity error should list both candidates, got %v", err)
	}
}

func TestSandboxStartWaitPolls(t *testing.T) {
	var polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/sandboxes":
			io.WriteString(w, `{"sandboxes":[{"id":"sb-1","name":"box","status":"stopped"}],"maxSandboxes":3}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/sandboxes/sb-1/start":
			io.WriteString(w, `{"success":true}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/sandboxes/sb-1":
			polls++
			io.WriteString(w, `{"id":"sb-1","name":"box","status":"running"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "start", "box", "--wait", "--timeout", "5s"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox start --wait: %v", err)
	}
	if polls != 1 {
		t.Errorf("status polls = %d, want 1", polls)
	}
}

func TestSandboxDeleteYes(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/apiv1/sandboxes" {
			io.WriteString(w, sandboxListJSON)
			return
		}
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"success":true}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "delete", "box", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/sandboxes/11111111-1111-1111-1111-111111111111" {
		t.Errorf("request = %s %s, want DELETE /apiv1/sandboxes/<id>", gotMethod, gotPath)
	}
}

func TestSandboxDeleteRefusesWithoutYes(t *testing.T) {
	var deletes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes++
		}
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "delete", "box"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if deletes != 0 {
		t.Errorf("server saw %d DELETEs, want 0", deletes)
	}
}

func TestSandboxDisabledFriendlyError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		io.WriteString(w, `{"message":"Sandbox feature is not enabled on this server"}`)
	}))
	defer srv.Close()

	root := greenhouseTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list"})
	err := root.Execute()
	if err == nil || err.Error() != errGreenhouseMissing.Error() {
		t.Fatalf("want the Greenhouse missing error, got %v", err)
	}
}

func TestSandboxRefusedWithoutGreenhouseGraft(t *testing.T) {
	var listed int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/instance/features" {
			io.WriteString(w, `{"mcp":true,"grafts":["announcements"],"sandboxes":true}`)
			return
		}
		listed++
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	for _, args := range [][]string{{"sandbox", "list"}, {"ssh-identity", "list"}} {
		root := greenhouseTestRoot(t, srv.URL)
		root.SetArgs(args)
		err := root.Execute()
		if err == nil || err.Error() != errGreenhouseMissing.Error() {
			t.Fatalf("%v: want the Greenhouse missing error, got %v", args, err)
		}
	}
	if listed != 0 {
		t.Errorf("server saw %d sandbox requests, want 0", listed)
	}
}

func TestSandboxFallsBackToSandboxesFlag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/instance/features" {
			io.WriteString(w, `{"mcp":true,"sandboxes":false}`)
			return
		}
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	root := greenhouseTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list"})
	if err := root.Execute(); err == nil || err.Error() != errGreenhouseMissing.Error() {
		t.Fatalf("want the Greenhouse missing error, got %v", err)
	}
}

func TestSandboxNotFoundPassesThroughOnceGreenhouseConfirmed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/instance/features" {
			io.WriteString(w, `{"mcp":true,"grafts":["greenhouse"],"sandboxes":true}`)
			return
		}
		w.WriteHeader(404)
		io.WriteString(w, `{"message":"Sandbox not found"}`)
	}))
	defer srv.Close()

	root := greenhouseTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "Sandbox not found") {
		t.Fatalf("want the server's not-found message, got %v", err)
	}
}

func TestSandboxProxySkipsGreenhouseProbe(t *testing.T) {
	var probed int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/instance/features" {
			probed++
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()

	root := greenhouseTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "proxy", "box"})
	_ = root.Execute()
	if probed != 0 {
		t.Errorf("proxy probed instance features %d times, want 0", probed)
	}
}

func TestSandboxSSHConfigOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "ssh-config", "box"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox ssh-config: %v", err)
		}
	})
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	exe, err = proxyCommandExecutable(exe)
	if err != nil {
		t.Fatalf("proxyCommandExecutable: %v", err)
	}
	for _, want := range []string{
		"Host orchard-box\n",
		"  HostName orchard-sandbox-11111111-1111-1111-1111-111111111111\n",
		"  User dev\n",
		"  ProxyCommand \"" + exe + "\" sandbox proxy 11111111-1111-1111-1111-111111111111\n",
		"  StrictHostKeyChecking accept-new\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("ssh-config output missing %q:\n%s", want, out)
		}
	}
}

func TestSandboxCredentialsSetStdin(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = sandboxDecodeBody(t, r)
		io.WriteString(w, `{"claude":true,"openai":false}`)
	}))
	defer srv.Close()

	rd, wr, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	oldStdin := os.Stdin
	os.Stdin = rd
	defer func() { os.Stdin = oldStdin }()
	io.WriteString(wr, "sk-ant-oat01-secret\n")
	wr.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "credentials", "set", "--claude", "-"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox credentials set: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/apiv1/sandboxes/credentials" {
		t.Errorf("request = %s %s, want PUT /apiv1/sandboxes/credentials", gotMethod, gotPath)
	}
	if gotBody["claudeToken"] != "sk-ant-oat01-secret" {
		t.Errorf("claudeToken = %v, want the trimmed stdin token", gotBody["claudeToken"])
	}
	if _, present := gotBody["openaiToken"]; present {
		t.Errorf("body = %v, want openaiToken omitted", gotBody)
	}
}

func TestSandboxChatStreamsText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/sandboxes":
			io.WriteString(w, sandboxListJSON)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/sandboxes/11111111-1111-1111-1111-111111111111/chat":
			body := sandboxDecodeBody(t, r)
			if body["message"] != "hi there" {
				t.Errorf("message = %v, want the joined args", body["message"])
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello from claude\"}]}}\n\n")
			io.WriteString(w, "data: {\"type\":\"done\"}\n\n")
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "chat", "box", "hi", "there"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox chat: %v", err)
		}
	})
	if !strings.Contains(out, "hello from claude") {
		t.Errorf("chat stdout missing the assistant text:\n%s", out)
	}
}

func TestSandboxChatErrorEvent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/apiv1/sandboxes" {
			io.WriteString(w, sandboxListJSON)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"type\":\"error\",\"detail\":\"agent crashed\"}\n\n")
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "chat", "box", "-m", "hi"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "agent crashed") {
		t.Fatalf("want the error event detail, got %v", err)
	}
}

func TestSandboxCredentialsStatus(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"claude":true,"openai":false}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "credentials", "status", "-o", "table"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox credentials status: %v", err)
		}
	})
	if gotMethod != http.MethodGet || gotPath != "/apiv1/sandboxes/credentials" {
		t.Errorf("request = %s %s, want GET /apiv1/sandboxes/credentials", gotMethod, gotPath)
	}
	if !strings.Contains(out, "configured") || strings.Contains(out, "true") {
		t.Errorf("status output should show presence words, never raw values:\n%s", out)
	}
}

func TestSandboxCreateRunner(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = sandboxDecodeBody(t, r)
		io.WriteString(w, `{"id":"sb-1","name":"box","status":"creating","runner":"vercel"}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "create", "box", "--runner", "Vercel"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox create: %v", err)
	}
	if gotBody["runner"] != "vercel" {
		t.Errorf("runner = %v, want vercel", gotBody["runner"])
	}
}

func TestSandboxCreateRunnerOmittedByDefault(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = sandboxDecodeBody(t, r)
		io.WriteString(w, `{"id":"sb-1","name":"box","status":"creating"}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "create", "box"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox create: %v", err)
	}
	if _, present := gotBody["runner"]; present {
		t.Errorf("body = %v, want runner omitted so the server uses its default", gotBody)
	}
}

func TestSandboxCreateRejectsUnknownRunner(t *testing.T) {
	root := sandboxTestRoot(t, "http://127.0.0.1:1")
	root.SetArgs([]string{"sandbox", "create", "box", "--runner", "docker"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "kubernetes or vercel") {
		t.Fatalf("want a runner usage error, got %v", err)
	}
}

func TestSandboxListShowsRunnerWhenPresent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"sandboxes":[{"id":"s1","name":"box","status":"running","runner":"vercel"},{"id":"s2","name":"old","status":"stopped"}],"runners":[{"id":"kubernetes","enabled":true},{"id":"vercel","enabled":true}],"defaultRunner":"kubernetes","maxSandboxes":3}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list", "-o", "table"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox list: %v", err)
		}
	})
	for _, want := range []string{"RUNNER", "vercel", "2 of 3 sandboxes used"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestSandboxListOldShapeHasNoRunnerColumn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, sandboxListJSON)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "list", "-o", "table"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox list: %v", err)
		}
	})
	if strings.Contains(out, "RUNNER") {
		t.Errorf("old response shape should not grow a runner column:\n%s", out)
	}
}

func TestSandboxGetShowsRunner(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/sandboxes":
			io.WriteString(w, `{"sandboxes":[{"id":"s1","name":"box","status":"running","runner":"vercel"}],"defaultRunner":"kubernetes"}`)
		case "/apiv1/sandboxes/s1":
			io.WriteString(w, `{"id":"s1","name":"box","status":"running","runner":"vercel"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "get", "box", "-o", "table"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("sandbox get: %v", err)
		}
	})
	if !strings.Contains(out, "runner") || !strings.Contains(out, "vercel") {
		t.Errorf("get output missing runner:\n%s", out)
	}
}
