package cmd

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sshIdentityListJSON = `{"identities":[{"id":"aaaa1111-1111-1111-1111-111111111111","name":"laptop","publicKey":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnop me@example","createdAt":"2026-08-01T00:00:00Z"}]}`

func sshIdentityCaptureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(r)
		done <- string(data)
	}()
	defer func() {
		os.Stderr = old
	}()
	fn()
	w.Close()
	os.Stderr = old
	return <-done
}

func TestSSHIdentityListTable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/apiv1/ssh-identities" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, sshIdentityListJSON)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"ssh-identity", "list", "-o", "table"})
	out := sandboxCaptureStdout(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("ssh-identity list: %v", err)
		}
	})
	key := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnop me@example"
	truncated := key[:20] + "..." + key[len(key)-12:]
	for _, want := range []string{"NAME", "KEY", "CREATED", "laptop", truncated} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, key) {
		t.Errorf("table output should truncate the key middle:\n%s", out)
	}
}

func TestSSHIdentityAddKeyFile(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/apiv1/ssh-identities" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		gotBody = sandboxDecodeBody(t, r)
		io.WriteString(w, `{"id":"aaaa1111-1111-1111-1111-111111111111","name":"laptop"}`)
	}))
	defer srv.Close()

	keyPath := filepath.Join(t.TempDir(), "key.pub")
	if err := os.WriteFile(keyPath, []byte("ssh-ed25519 AAAAtest user@host\n"), 0o600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"ssh-identity", "add", "laptop", "--key", "@" + keyPath})
	if err := root.Execute(); err != nil {
		t.Fatalf("ssh-identity add: %v", err)
	}
	if gotBody["name"] != "laptop" {
		t.Errorf("name = %v, want laptop", gotBody["name"])
	}
	if gotBody["publicKey"] != "ssh-ed25519 AAAAtest user@host" {
		t.Errorf("publicKey = %v, want the trimmed file content", gotBody["publicKey"])
	}
}

func TestSSHIdentityRemoveConflict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/apiv1/ssh-identities" {
			io.WriteString(w, sshIdentityListJSON)
			return
		}
		if r.Method != http.MethodDelete || r.URL.Path != "/apiv1/ssh-identities/aaaa1111-1111-1111-1111-111111111111" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(409)
		io.WriteString(w, `{"message":"identity is attached to sandbox box"}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"ssh-identity", "remove", "laptop", "--yes"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "attached to sandbox box") {
		t.Fatalf("want the 409 conflict message, got %v", err)
	}
	if err != nil && strings.Contains(err.Error(), "orchard api error") {
		t.Errorf("409 message should be surfaced without the api error wrapper, got %v", err)
	}
}

func TestSSHIdentityImportGithub(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/apiv1/ssh-identities/import-github" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, `{"identities":[{"id":"bbbb2222-2222-2222-2222-222222222222","name":"github-1"}]}`)
	}))
	defer srv.Close()

	root := sandboxTestRoot(t, srv.URL)
	root.SetArgs([]string{"ssh-identity", "import-github", "-o", "table"})
	out := sshIdentityCaptureStderr(t, func() {
		if err := root.Execute(); err != nil {
			t.Errorf("ssh-identity import-github: %v", err)
		}
	})
	if !strings.Contains(out, "github-1") {
		t.Errorf("import output missing the created identity name:\n%s", out)
	}
}
