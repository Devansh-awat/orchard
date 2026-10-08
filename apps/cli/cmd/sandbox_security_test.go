package cmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
)

func TestResolveSandboxPrefersYourOwnMachineByName(t *testing.T) {
	body := `{"sandboxes":[` +
		`{"id":"aaaaaaaa-0000-4000-8000-000000000001","name":"api","myRole":"collaborator"},` +
		`{"id":"aaaaaaaa-0000-4000-8000-000000000002","name":"api","myRole":"owner"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, body)
	}))
	defer srv.Close()
	cl := api.New(srv.URL, "tok")
	sb, err := resolveSandbox(context.Background(), cl, "api")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if str(sb["id"]) != "aaaaaaaa-0000-4000-8000-000000000002" {
		t.Fatalf("want the owned machine, got %v", sb["id"])
	}
}

func TestResolveSandboxRefusesTwoSharedMachinesWithTheSameName(t *testing.T) {
	body := `{"sandboxes":[` +
		`{"id":"aaaaaaaa-0000-4000-8000-000000000001","name":"api","myRole":"collaborator"},` +
		`{"id":"aaaaaaaa-0000-4000-8000-000000000002","name":"api","myRole":"viewer"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, body)
	}))
	defer srv.Close()
	_, err := resolveSandbox(context.Background(), api.New(srv.URL, "tok"), "api")
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("want an ambiguity error, got %v", err)
	}
}

func TestTerminalTextDropsControlSequences(t *testing.T) {
	in := "ok\x1b]52;c;ZXZpbA==\x07 done\x1b[2J\tline\nnext\r\u009bX"
	got := terminalSafe(in)
	if strings.ContainsAny(got, "\x1b\x07\r\u009b") {
		t.Fatalf("control bytes survived: %q", got)
	}
	if !strings.Contains(got, "\tline\nnext") {
		t.Fatalf("tabs and newlines must survive: %q", got)
	}
}

func TestKnownHostsIgnoresHostileAliasesAndKeys(t *testing.T) {
	if got := rewriteKnownHosts("", "orchard-box\n* ssh-ed25519 AAAA", []string{"ssh-ed25519 AAAAC3"}); got != "" {
		t.Fatalf("a hostile alias must not be written: %q", got)
	}
	if !validHostKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==") || !validHostKey("ecdsa-sha2-nistp256 AAAA") {
		t.Fatal("real host keys must pass")
	}
	if validHostKey("@revoked AAAA") || validHostKey("ssh-ed25519") {
		t.Fatal("markers and malformed keys must not pass")
	}
}

func TestProxyCommandQuotesTheHostName(t *testing.T) {
	cfg, err := renderOrchardSSHConfig("/usr/local/bin/orchard")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cfg, "sandbox proxy --host '%n'") {
		t.Fatalf("the ssh host name must be single quoted in ProxyCommand:\n%s", cfg)
	}
}
