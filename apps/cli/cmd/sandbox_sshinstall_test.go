package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
	"github.com/hackclub/orchard/cli/internal/exitcode"
)

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func assertPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Errorf("%s mode = %o, want %o", path, got, want)
	}
}

func TestEnsureOrchardSSHIncludeCreatesFiles(t *testing.T) {
	p := orchardSSHPaths{Home: t.TempDir()}
	added, err := ensureOrchardSSHInclude(p)
	if err != nil || !added {
		t.Fatalf("first insert: added=%v err=%v", added, err)
	}
	if got := readFile(t, p.UserSSHConfig()); got != orchardSSHInclude+"\n" {
		t.Errorf("config = %q", got)
	}
	assertPerm(t, filepath.Dir(p.UserSSHConfig()), 0o700)
	assertPerm(t, p.UserSSHConfig(), 0o600)
	added, err = ensureOrchardSSHInclude(p)
	if err != nil || added {
		t.Fatalf("second insert: added=%v err=%v, want a no-op", added, err)
	}
}

func TestEnsureOrchardSSHIncludePrependsAboveHostBlocks(t *testing.T) {
	p := orchardSSHPaths{Home: t.TempDir()}
	if err := os.MkdirAll(filepath.Dir(p.UserSSHConfig()), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := "Host github.com\n  User git\n\nHost *\n  AddKeysToAgent yes\n"
	if err := os.WriteFile(p.UserSSHConfig(), []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := ensureOrchardSSHInclude(p); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	got := readFile(t, p.UserSSHConfig())
	if want := orchardSSHInclude + "\n\n" + existing; got != want {
		t.Errorf("config = %q, want %q", got, want)
	}
	if strings.Count(got, "Include") != 1 {
		t.Errorf("include inserted more than once:\n%s", got)
	}
	assertPerm(t, p.UserSSHConfig(), 0o644)
}

func TestEnsureOrchardSSHIncludeRecognisesExistingForms(t *testing.T) {
	p := orchardSSHPaths{Home: "/home/me"}
	for _, content := range []string{
		"Include ~/.orchard/ssh/config\nHost x\n",
		"# top\ninclude=~/.orchard/ssh/config\n",
		"  INCLUDE ~/.ssh/other \"/home/me/.orchard/ssh/config\"\n",
	} {
		if !hasOrchardSSHInclude(content, p) {
			t.Errorf("did not recognise include in %q", content)
		}
	}
	for _, content := range []string{
		"",
		"Host x\n  Include ~/.orchard/ssh/config\n",
		"Match host y\nInclude ~/.orchard/ssh/config\n",
		"Include ~/.orchard/ssh/config.d/*\n",
	} {
		if hasOrchardSSHInclude(content, p) {
			t.Errorf("wrongly treated %q as a top-level include", content)
		}
	}
}

func TestWriteOrchardSSHConfig(t *testing.T) {
	p := orchardSSHPaths{Home: t.TempDir()}
	changed, err := writeOrchardSSHConfig(p, "/opt/orchard 100%/bin/orchard")
	if err != nil || !changed {
		t.Fatalf("write: changed=%v err=%v", changed, err)
	}
	want := "Host orchard-*\n" +
		"  User dev\n" +
		"  IdentityFile ~/.orchard/ssh/id_ed25519\n" +
		"  IdentitiesOnly yes\n" +
		"  ProxyCommand \"/opt/orchard 100%%/bin/orchard\" sandbox proxy --host %n\n" +
		"  StrictHostKeyChecking accept-new\n" +
		"  UserKnownHostsFile ~/.orchard/ssh/known_hosts\n" +
		"  ServerAliveInterval 30\n"
	if got := readFile(t, p.Config()); got != want {
		t.Errorf("config =\n%s\nwant\n%s", got, want)
	}
	assertPerm(t, p.Dir(), 0o700)
	assertPerm(t, p.Config(), 0o600)
	changed, err = writeOrchardSSHConfig(p, "/opt/orchard 100%/bin/orchard")
	if err != nil || changed {
		t.Fatalf("rewrite: changed=%v err=%v, want a no-op", changed, err)
	}
	if _, err := writeOrchardSSHConfig(p, "/tmp/a\"b/orchard"); err == nil {
		t.Error("a quote in the executable path must be refused")
	}
}

func TestEnsureOrchardSSHKeyGeneratesOnce(t *testing.T) {
	p := orchardSSHPaths{Home: t.TempDir()}
	pub, created, err := ensureOrchardSSHKey(p, "orchard-cli@test")
	if err != nil || !created {
		t.Fatalf("generate: created=%v err=%v", created, err)
	}
	assertPerm(t, p.Key(), 0o600)
	assertPerm(t, p.Dir(), 0o700)
	again, created, err := ensureOrchardSSHKey(p, "orchard-cli@test")
	if err != nil || created || again != pub {
		t.Fatalf("second call: created=%v err=%v key changed=%v", created, err, again != pub)
	}
	if err := os.Remove(p.PublicKey()); err != nil {
		t.Fatal(err)
	}
	derived, created, err := ensureOrchardSSHKey(p, "orchard-cli@test")
	if err != nil || created || derived != pub {
		t.Fatalf("derive from private: created=%v err=%v got %q want %q", created, err, derived, pub)
	}
}

func TestSSHIdentityNameForHost(t *testing.T) {
	cases := map[string]string{
		"leafs-MacBook-Pro.local": "orchard-cli-leafs-MacBook-Pro.local",
		"":                        "orchard-cli",
		"bad host!!name":          "orchard-cli-bad-host-name",
		"--weird--":               "orchard-cli-weird",
	}
	for in, want := range cases {
		if got := sshIdentityNameForHost(in); got != want {
			t.Errorf("sshIdentityNameForHost(%q) = %q, want %q", in, got, want)
		}
	}
	if got := sshIdentityNameForHost(strings.Repeat("a", 200)); len(got) > 100 {
		t.Errorf("name too long: %d", len(got))
	}
}

func TestSandboxSSHConfigInstall(t *testing.T) {
	var mu sync.Mutex
	var registered []map[string]any
	host, _ := os.Hostname()
	takenName := sshIdentityNameForHost(host)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/ssh-identities":
			items := []map[string]any{{"id": "id-0", "name": takenName, "publicKey": "ssh-ed25519 AAAAother laptop"}}
			for _, reg := range registered {
				items = append(items, map[string]any{"id": "id-new", "name": reg["name"], "publicKey": reg["publicKey"]})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"identities": items})
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/ssh-identities":
			body := sandboxDecodeBody(t, r)
			registered = append(registered, body)
			_ = json.NewEncoder(w).Encode(body)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/sandboxes":
			io.WriteString(w, sandboxListJSON)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	var home string
	for i := 0; i < 2; i++ {
		root := sandboxTestRoot(t, srv.URL)
		if home == "" {
			home = os.Getenv("HOME")
		} else {
			t.Setenv("HOME", home)
		}
		root.SetArgs([]string{"sandbox", "ssh-config", "--install", "-o", "json"})
		out := sandboxCaptureStdout(t, func() {
			if err := root.Execute(); err != nil {
				t.Errorf("install run %d: %v", i, err)
			}
		})
		var res sshInstallResult
		if err := json.Unmarshal([]byte(out), &res); err != nil {
			t.Fatalf("decode install output %q: %v", out, err)
		}
		if res.Example != "ssh orchard-box" {
			t.Errorf("example = %q", res.Example)
		}
		if i == 0 && (!res.KeyCreated || !res.IdentityCreated || !res.IncludeAdded || !res.ConfigChanged) {
			t.Errorf("first run should create everything: %+v", res)
		}
		if i == 1 && (res.KeyCreated || res.IdentityCreated || res.IncludeAdded || res.ConfigChanged) {
			t.Errorf("second run should be a no-op: %+v", res)
		}
	}

	if len(registered) != 1 {
		t.Fatalf("registered %d identities, want exactly 1", len(registered))
	}
	if want := takenName + "-2"; registered[0]["name"] != want {
		t.Errorf("identity name = %v, want %q (the bare name was taken)", registered[0]["name"], want)
	}
	p := orchardSSHPaths{Home: home}
	if pub := strings.TrimSpace(readFile(t, p.PublicKey())); registered[0]["publicKey"] != pub {
		t.Errorf("registered key %v, want %q", registered[0]["publicKey"], pub)
	}
	assertPerm(t, p.Key(), 0o600)
	exe, err := orchardExecutablePath()
	if err != nil {
		t.Fatal(err)
	}
	if cfg := readFile(t, p.Config()); !strings.Contains(cfg, "  ProxyCommand \""+exe+"\" sandbox proxy --host %n\n") {
		t.Errorf("config missing ProxyCommand for %s:\n%s", exe, cfg)
	}
	if got := readFile(t, p.UserSSHConfig()); !strings.HasPrefix(got, orchardSSHInclude+"\n") {
		t.Errorf("~/.ssh/config = %q", got)
	}
}

func TestSandboxSSHConfigInstallRejectsName(t *testing.T) {
	root := sandboxTestRoot(t, "http://127.0.0.1:1")
	root.SetArgs([]string{"sandbox", "ssh-config", "box", "--install"})
	err := root.Execute()
	var usage *exitcode.UsageError
	if err == nil || !errors.As(err, &usage) {
		t.Fatalf("want a usage error, got %v", err)
	}
}

func TestSandboxNameFromSSHHost(t *testing.T) {
	cases := map[string]string{
		"orchard-box":         "box",
		"orchard-orchard-box": "orchard-box",
		"dev@orchard-box":     "box",
		"box":                 "box",
	}
	for in, want := range cases {
		if got := sandboxNameFromSSHHost(in); got != want {
			t.Errorf("sandboxNameFromSSHHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSandboxProxyHostResolvesByName(t *testing.T) {
	tunnelPath := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/sandboxes":
			io.WriteString(w, sandboxListJSON)
		case r.URL.Path == "/apiv1/sandboxes/11111111-1111-1111-1111-111111111111/hostkey":
			io.WriteString(w, `{"publicKeys":["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFRESH"]}`)
		case strings.HasSuffix(r.URL.Path, "/ssh"):
			tunnelPath <- r.URL.Path
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			c.Close(websocket.StatusNormalClosure, "")
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	rd, wr, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer wr.Close()
	oldStdin := os.Stdin
	os.Stdin = rd
	defer func() { os.Stdin = oldStdin }()

	root := sandboxTestRoot(t, srv.URL)
	p := orchardSSHPaths{Home: os.Getenv("HOME")}
	if err := os.MkdirAll(p.Dir(), 0o700); err != nil {
		t.Fatal(err)
	}
	stale := "orchard-box ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISTALE\norchard-other ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER\n"
	if err := os.WriteFile(p.KnownHosts(), []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}
	root.SetArgs([]string{"sandbox", "proxy", "--host", "dev@orchard-box"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox proxy --host: %v", err)
	}
	if got := <-tunnelPath; got != "/apiv1/sandboxes/11111111-1111-1111-1111-111111111111/ssh" {
		t.Errorf("tunnel path = %q", got)
	}
	want := "orchard-other ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER\norchard-box ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFRESH\n"
	if got := readFile(t, p.KnownHosts()); got != want {
		t.Errorf("known_hosts = %q, want %q", got, want)
	}
	assertPerm(t, p.KnownHosts(), 0o600)
}

func TestSandboxProxyToleratesServersWithoutHostKeys(t *testing.T) {
	tunnelPath := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/sandboxes":
			io.WriteString(w, sandboxListJSON)
		case strings.HasSuffix(r.URL.Path, "/ssh"):
			tunnelPath <- r.URL.Path
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			c.Close(websocket.StatusNormalClosure, "")
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	rd, wr, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer wr.Close()
	oldStdin := os.Stdin
	os.Stdin = rd
	defer func() { os.Stdin = oldStdin }()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"sandbox", "proxy", "--host", "orchard-box"})
	if err := root.Execute(); err != nil {
		t.Fatalf("sandbox proxy --host: %v", err)
	}
	<-tunnelPath
	p := orchardSSHPaths{Home: os.Getenv("HOME")}
	if _, err := os.Stat(p.KnownHosts()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("known_hosts should not be created without keys, stat err = %v", err)
	}
}

func TestSandboxProxyNeedsTarget(t *testing.T) {
	root := sandboxTestRoot(t, "http://127.0.0.1:1")
	root.SetArgs([]string{"sandbox", "proxy"})
	var usage *exitcode.UsageError
	if err := root.Execute(); err == nil || !errors.As(err, &usage) {
		t.Fatalf("want a usage error, got %v", err)
	}
}
