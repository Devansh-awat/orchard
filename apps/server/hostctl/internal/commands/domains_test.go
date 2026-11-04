package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const publicValues = `
ingress:
  host: orchard.old.dev
  extraHosts: [orchard.new.dev, mango]
  tls:
    enabled: true
gateway:
  http:
    appDomain: apps.old.dev
frontend:
  env:
    - { name: PUBLIC_APP_DOMAIN, value: apps.old.dev }
    - { name: PUBLIC_HTTP_PORT, value: "80" }
mcp:
  enabled: true
  ingress:
    host: mcp.apps.old.dev
server:
  env:
    - { name: JWT_SECRET, value: sekrit }
    - { name: APP_DOMAIN, value: apps.old.dev }
    - { name: INSTALL_INGRESS_MODE, value: public }
    - { name: FRONTEND_URL, value: https://orchard.old.dev }
`

func runCommand(t *testing.T, cmd *cli.Command, body string, args ...string) (string, *cli.Values, error) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "values.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(dir, "output"))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()

	context := &cli.Context{
		Env:    cli.Env{Values: path, Namespace: "orchard"},
		Stdout: output,
		Stderr: output,
	}
	runErr := cmd.Run(context, args)

	printed, err := os.ReadFile(output.Name())
	if err != nil {
		t.Fatal(err)
	}
	saved, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(printed), saved, runErr
}

func fakeKubectl(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"" + log + "\"\n" +
		"case \"$*\" in *jsonpath*) printf 'old@example.com' ;; esac\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func TestHostnameSetMovesBothValuesAndKeepsTheOthers(t *testing.T) {
	out, values, err := runCommand(t, Hostname(), publicValues, "set", "https://Orchard.New.Dev/")
	if err != nil {
		t.Fatal(err)
	}
	if got := values.Get("ingress.host"); got != "orchard.new.dev" {
		t.Errorf("ingress.host = %v", got)
	}
	if got := values.EnvValue(serverEnvPath, "FRONTEND_URL"); got != "https://orchard.new.dev" {
		t.Errorf("FRONTEND_URL = %q", got)
	}
	if got := values.EnvValue(serverEnvPath, "JWT_SECRET"); got != "sekrit" {
		t.Errorf("JWT_SECRET should stay, got %q", got)
	}
	if got := hostList(values); len(got) != 1 || got[0] != "mango" {
		t.Errorf("extra names should drop the new primary and keep the rest, got %v", got)
	}
	for _, want := range []string{
		"Dashboard moves from orchard.old.dev to orchard.new.dev",
		"Everyone signs in again",
		"Passkeys belong to the old name",
		"GitHub App",
		"Point an A record for orchard.new.dev",
		"written, not deployed yet",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output is missing %q:\n%s", want, out)
		}
	}
}

func TestHostnameSetKeepsThePortOnALanInstall(t *testing.T) {
	lan := `
ingress:
  host: 192.168.4.27
  tls:
    enabled: false
server:
  env:
    - { name: INSTALL_INGRESS_MODE, value: lan }
    - { name: FRONTEND_URL, value: http://192.168.4.27:8081 }
`
	out, values, err := runCommand(t, Hostname(), lan, "set", "mango")
	if err != nil {
		t.Fatal(err)
	}
	if got := values.EnvValue(serverEnvPath, "FRONTEND_URL"); got != "http://mango:8081" {
		t.Errorf("FRONTEND_URL = %q", got)
	}
	if !strings.Contains(out, "resolves on your network") {
		t.Errorf("lan advice is missing:\n%s", out)
	}
}

func TestHostnameSetRefusesWhatCannotWork(t *testing.T) {
	for name, raw := range map[string]string{
		"an address on a public install":  "203.0.113.10",
		"a bare name on a public install": "mango",
		"the current name":                "orchard.old.dev",
		"the MCP hostname":                "mcp.apps.old.dev",
	} {
		_, values, err := runCommand(t, Hostname(), publicValues, "set", raw)
		if err == nil {
			t.Errorf("%s should be refused", name)
		}
		if got := values.Get("ingress.host"); got != "orchard.old.dev" {
			t.Errorf("%s changed ingress.host to %v", name, got)
		}
	}
}

func TestAppsDomainSetWritesEverythingTheChartReads(t *testing.T) {
	out, values, err := runCommand(t, AppsDomain(), publicValues, "set", "*.apps.new.dev")
	if err != nil {
		t.Fatal(err)
	}
	if got := values.Get(appDomainPath); got != "apps.new.dev" {
		t.Errorf("%s = %v", appDomainPath, got)
	}
	if got := values.EnvValue(serverEnvPath, appDomainEnv); got != "apps.new.dev" {
		t.Errorf("APP_DOMAIN = %q", got)
	}
	if got := values.EnvValue("frontend.env", publicAppDomainEnv); got != "" {
		t.Errorf("a pinned PUBLIC_APP_DOMAIN would keep the frontend on the old domain, got %q", got)
	}
	if got := values.EnvValue("frontend.env", "PUBLIC_HTTP_PORT"); got != "80" {
		t.Errorf("other frontend variables should stay, got %q", got)
	}
	for _, want := range []string{
		"Apps domain moves from apps.old.dev to apps.new.dev. Only new apps use it.",
		"Deployed apps keep their addresses",
		"Point an A record for *.apps.new.dev",
		"The MCP endpoint stays at mcp.apps.old.dev",
		"written, not deployed yet",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output is missing %q:\n%s", want, out)
		}
	}
}

func TestAppsDomainSetWarnsAboutAWildcardThatOutranksIt(t *testing.T) {
	body := publicValues + "tenant:\n  wildcardDomains: .apps.old.dev=wildcard-tls\n"
	out, _, err := runCommand(t, AppsDomain(), body, "set", "apps.new.dev")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "tenant.wildcardDomains is also set") {
		t.Errorf("the override should be named:\n%s", out)
	}
}

func TestAppsDomainRefusesWhatIsNotADomain(t *testing.T) {
	for _, raw := range []string{"203.0.113.10", "apps", "apps.old.dev", "*."} {
		if _, _, err := runCommand(t, AppsDomain(), publicValues, "set", raw); err == nil {
			t.Errorf("%q should be refused", raw)
		}
	}
}

func TestLetsEncryptEmailPatchesTheIssuer(t *testing.T) {
	log := fakeKubectl(t)
	out, _, err := runCommand(t, LetsEncryptEmail(), publicValues, "set", "you@example.com")
	if err != nil {
		t.Fatal(err)
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	want := `-n orchard patch clusterissuer letsencrypt --type=merge -p {"spec":{"acme":{"email":"you@example.com"}}}`
	if strings.TrimSpace(string(calls)) != want {
		t.Errorf("kubectl got %s", calls)
	}
	if !strings.Contains(out, "Certificates don't change") {
		t.Errorf("output: %s", out)
	}
}

func TestLetsEncryptEmailShowsAndRemoves(t *testing.T) {
	log := fakeKubectl(t)
	out, _, err := runCommand(t, LetsEncryptEmail(), publicValues)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "old@example.com" {
		t.Errorf("show printed %q", out)
	}
	if _, _, err := runCommand(t, LetsEncryptEmail(), publicValues, "unset"); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	if !strings.Contains(string(calls), `{"spec":{"acme":{"email":null}}}`) {
		t.Errorf("unset should clear the field, kubectl got %s", calls)
	}
}

func TestLetsEncryptEmailRefusesBadInputAndOtherModes(t *testing.T) {
	log := fakeKubectl(t)
	for _, raw := range []string{"nope", "you@", "you@localhost", "two words@example.com"} {
		if _, _, err := runCommand(t, LetsEncryptEmail(), publicValues, "set", raw); err == nil {
			t.Errorf("%q should be refused", raw)
		}
	}
	lan := "server:\n  env:\n    - { name: INSTALL_INGRESS_MODE, value: lan }\n"
	_, _, err := runCommand(t, LetsEncryptEmail(), lan, "set", "you@example.com")
	if err == nil || !strings.Contains(err.Error(), "doesn't use Let's Encrypt") {
		t.Errorf("lan mode should be refused, got %v", err)
	}
	if calls, err := os.ReadFile(log); err == nil {
		t.Errorf("nothing should reach kubectl, got %s", calls)
	}
}

func TestRetrofitInstallModeMarksOlderHostsOnce(t *testing.T) {
	for want, body := range map[string]string{
		"public": "ingress:\n  tls:\n    enabled: true\nserver:\n  env:\n    - { name: FRONTEND_URL, value: https://a.dev }\n",
		"tunnel": "ingress:\n  tls:\n    enabled: false\nserver:\n  env:\n    - { name: FRONTEND_URL, value: https://a.dev }\n",
		"lan":    "ingress:\n  tls:\n    enabled: false\nserver:\n  env:\n    - { name: FRONTEND_URL, value: http://a.dev }\n",
	} {
		values := load(t, body)
		if changes := retrofitInstallMode(values); len(changes) != 1 {
			t.Errorf("%s: changes = %v", want, changes)
		}
		if got := values.EnvValue(serverEnvPath, installModeEnv); got != want {
			t.Errorf("mode = %q, want %q", got, want)
		}
		if changes := retrofitInstallMode(values); changes != nil {
			t.Errorf("%s: a second run should change nothing, got %v", want, changes)
		}
	}
}

func TestRetrofitInstallModeLeavesAnEmptyFileAlone(t *testing.T) {
	values := load(t, "signupMode: open\n")
	if changes := retrofitInstallMode(values); changes != nil {
		t.Errorf("changes = %v", changes)
	}
	if got := values.EnvValue(serverEnvPath, installModeEnv); got != "" {
		t.Errorf("mode = %q", got)
	}
}

func TestMcpEnableKeepsThePortAndTellsAgentsToReconnect(t *testing.T) {
	lan := `
ingress:
  host: mango
  tls:
    enabled: false
mcp:
  enabled: true
  ingress:
    host: mcp.old.dev
server:
  env:
    - { name: JWT_SECRET, value: sekrit }
    - { name: INSTALL_INGRESS_MODE, value: lan }
    - { name: APP_DOMAIN, value: apps.new.dev }
    - { name: FRONTEND_URL, value: http://mango:8081 }
`
	out, values, err := runCommand(t, Mcp(), lan, "enable", "mcp.apps.new.dev")
	if err != nil {
		t.Fatal(err)
	}
	if got := values.Get(mcpURLPath); got != "http://mcp.apps.new.dev:8081" {
		t.Errorf("mcp.url = %v", got)
	}
	if !strings.Contains(out, "Agents must reconnect") {
		t.Errorf("output: %s", out)
	}
	if !strings.Contains(out, "needs no record of its own") {
		t.Errorf("output: %s", out)
	}
}
