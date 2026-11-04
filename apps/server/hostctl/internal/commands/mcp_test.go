package commands

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func load(t *testing.T, body string) *cli.Values {
	t.Helper()
	path := filepath.Join(t.TempDir(), "values.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func TestDefaultMcpHostIsASiblingOfTheUI(t *testing.T) {
	for host, want := range map[string]string{
		"orchard.example.com": "mcp.example.com",
		"orchard.local":       "mcp.local",
		"example.com":         "mcp.com",
		"localhost":           "",
		"":                    "",
	} {
		if got := defaultMcpHost("", host); got != want {
			t.Fatalf("%q should derive %q, got %q", host, want, got)
		}
	}
}

func TestDefaultMcpHostPrefersTheAppDomain(t *testing.T) {
	got := defaultMcpHost("apps.example.com", "orchard.example.com")
	if got != "mcp.apps.example.com" {
		t.Fatalf("got %q", got)
	}
}

// The two processes have to agree on the service token or every tool call
// fails at authentication, long after the upgrade reported success.
func TestWireCredentialsSharesOneTokenWithTheServer(t *testing.T) {
	values := load(t, "server:\n  env:\n    - {name: JWT_SECRET, value: sekrit}\n")
	if err := wireCredentials(values); err != nil {
		t.Fatal(err)
	}

	if got := values.EnvValue(mcpEnvPath, "JWT_SECRET"); got != "sekrit" {
		t.Fatalf("JWT_SECRET should be copied across, got %q", got)
	}
	server := values.EnvValue(serverEnvPath, serviceTokenKey)
	mcp := values.EnvValue(mcpEnvPath, serviceTokenKey)
	if server == "" || server != mcp {
		t.Fatalf("both sides need the same token, got %q and %q", server, mcp)
	}
}

func TestWireCredentialsKeepsAnExistingToken(t *testing.T) {
	values := load(t, "server:\n  env:\n    - {name: JWT_SECRET, value: s}\n    - {name: MCP_SERVICE_TOKEN, value: already-here}\n")
	if err := wireCredentials(values); err != nil {
		t.Fatal(err)
	}
	if got := values.EnvValue(mcpEnvPath, serviceTokenKey); got != "already-here" {
		t.Fatalf("rotating the token would break live sessions, got %q", got)
	}
}

func TestWireCredentialsRefusesWithoutAServerSecret(t *testing.T) {
	if err := wireCredentials(load(t, "server: {}\n")); err == nil {
		t.Fatal("an MCP with no JWT_SECRET validates nothing; this should fail loudly")
	}
}

func discard(t *testing.T) *os.File {
	t.Helper()
	f, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func run(t *testing.T, path string, args ...string) error {
	t.Helper()
	out := discard(t)
	ctx := &cli.Context{
		Env:    cli.Env{Values: path, Namespace: "orchard"},
		Stdout: out,
		Stderr: out,
	}
	return Mcp().Run(ctx, args)
}

// What an instance installed before MCP shipped by default looks like, and the
// one command that is meant to fix it.
func TestEnableFillsInEverythingAnOldInstallIsMissing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	body := `ingress:
  enabled: true
  host: orchard.example.com
  entryPoints: [websecure]
  tls:
    enabled: true
    issuerRef:
      name: letsencrypt
      kind: ClusterIssuer
server:
  env:
    - {name: JWT_SECRET, value: sekrit}
mcp:
  enabled: false
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(t, path, "enable"); err != nil {
		t.Fatal(err)
	}

	values, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	if enabled, _ := values.Get(mcpEnabledPath).(bool); !enabled {
		t.Fatal("mcp should be on")
	}
	if host, _ := values.Get(mcpHostPath).(string); host != "mcp.example.com" {
		t.Fatalf("expected mcp.example.com, got %q", host)
	}
	if got := values.Get("mcp.ingress.tls.issuerRef.name"); got != "letsencrypt" {
		t.Fatalf("a self-signed certificate is refused by every client, got %v", got)
	}
	if tls, _ := values.Get("mcp.ingress.tls.enabled").(bool); !tls {
		t.Fatal("the MCP route should terminate TLS wherever the UI's does")
	}
	if values.EnvValue(mcpEnvPath, serviceTokenKey) != values.EnvValue(serverEnvPath, serviceTokenKey) {
		t.Fatal("both processes need the same service token")
	}
}

// Re-running it must not rotate the token or move a hostname chosen by hand.
func TestEnableIsSafeToRerun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	body := "ingress:\n  host: orchard.example.com\nserver:\n  env:\n    - {name: JWT_SECRET, value: s}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(t, path, "enable", "agents.example.com"); err != nil {
		t.Fatal(err)
	}
	first, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	token := first.EnvValue(mcpEnvPath, serviceTokenKey)

	if err := run(t, path, "enable"); err != nil {
		t.Fatal(err)
	}
	second, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	if host, _ := second.Get(mcpHostPath).(string); host != "agents.example.com" {
		t.Fatalf("a hostname already set should be kept, got %q", host)
	}
	if got := second.EnvValue(mcpEnvPath, serviceTokenKey); got != token {
		t.Fatal("rotating the token would break every live agent session")
	}
}

func TestDisableLeavesTheHostnameAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	body := "mcp:\n  enabled: true\n  ingress:\n    host: mcp.example.com\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(t, path, "disable"); err != nil {
		t.Fatal(err)
	}
	values, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	if enabled, _ := values.Get(mcpEnabledPath).(bool); enabled {
		t.Fatal("mcp should be off")
	}
	if host, _ := values.Get(mcpHostPath).(string); host != "mcp.example.com" {
		t.Fatalf("turning it off should not forget where it was, got %q", host)
	}
}

// Tunnel mode: Traefik answers plaintext in-cluster while clients connect over
// https. An OAuth issuer that disagrees with the URL the client typed is
// rejected, so the derived scheme has to follow the public origin, not the route.
func TestEnableBehindATunnelAdvertisesHttps(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	body := `ingress:
  host: orchard.example.com
  tls:
    enabled: false
server:
  env:
    - {name: JWT_SECRET, value: s}
    - {name: FRONTEND_URL, value: "https://orchard.example.com"}
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(t, path, "enable"); err != nil {
		t.Fatal(err)
	}
	values, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := values.Get(mcpURLPath).(string); got != "https://mcp.example.com" {
		t.Fatalf("expected https, got %q", got)
	}
	if tls, _ := values.Get("mcp.ingress.tls.enabled").(bool); tls {
		t.Fatal("the route itself still terminates plaintext")
	}
}

func TestEnableOnALanInstallStaysHttp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	body := `ingress:
  host: orchard.10-0-0-5.sslip.io
  tls:
    enabled: false
server:
  env:
    - {name: JWT_SECRET, value: s}
    - {name: FRONTEND_URL, value: "http://orchard.10-0-0-5.sslip.io"}
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(t, path, "enable"); err != nil {
		t.Fatal(err)
	}
	values, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := values.Get(mcpURLPath).(string); got != "http://mcp.10-0-0-5.sslip.io" {
		t.Fatalf("expected http, got %q", got)
	}
}
