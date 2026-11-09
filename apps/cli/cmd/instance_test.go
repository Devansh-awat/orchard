package cmd

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/tui"
)

func startOrchard(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/health":
			_, _ = w.Write([]byte(`{"status":"ok","message":"Server is running","version":"1.2.3"}`))
		case "/apiv1/auth/me":
			_, _ = w.Write([]byte(`{"email":"a@example.com"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func firstRunHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORCHARD_API_URL", "")
	t.Setenv("ORCHARD_API_TOKEN", "")
	t.Setenv("ORCHARD_CONTEXT", "")
	return home
}

func stubPrompt(t *testing.T, can bool, ask func(context.Context, tui.InstanceCheck) (string, bool, error)) {
	t.Helper()
	oldCan, oldAsk := canAskForInstance, askInstanceURL
	canAskForInstance = func() bool { return can }
	askInstanceURL = ask
	t.Cleanup(func() { canAskForInstance, askInstanceURL = oldCan, oldAsk })
}

func neverAsk(t *testing.T) func(context.Context, tui.InstanceCheck) (string, bool, error) {
	return func(context.Context, tui.InstanceCheck) (string, bool, error) {
		t.Fatal("prompted for an instance")
		return "", false, nil
	}
}

func answer(raw string) func(context.Context, tui.InstanceCheck) (string, bool, error) {
	return func(ctx context.Context, check tui.InstanceCheck) (string, bool, error) {
		url, err := check(ctx, raw)
		return url, err == nil, err
	}
}

func execLogin(t *testing.T, args ...string) error {
	t.Helper()
	c := authLoginCmd()
	c.SilenceUsage = true
	c.SilenceErrors = true
	c.SetArgs(args)
	return c.ExecuteContext(context.Background())
}

func writeConfig(t *testing.T, home, body string) string {
	t.Helper()
	dir := filepath.Join(home, ".orchard")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "config.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNoInstanceWithoutTerminalNamesTheFlagAndEnv(t *testing.T) {
	home := firstRunHome(t)
	stubPrompt(t, false, neverAsk(t))
	loginErr := execLogin(t, "--token", "orch_x")
	_, _, clientErr := client()
	for _, err := range []error{loginErr, clientErr} {
		if err == nil || !strings.Contains(err.Error(), "--api-url") || !strings.Contains(err.Error(), "ORCHARD_API_URL") {
			t.Fatalf("err = %v, want it to name --api-url and ORCHARD_API_URL", err)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".orchard", "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config written without an instance: %v", err)
	}
}

func TestCIIsNeverAskedForAnInstance(t *testing.T) {
	t.Setenv("CI", "true")
	if terminalCanAsk() {
		t.Fatal("CI should not prompt")
	}
}

func TestFirstLoginAsksThenSignsIn(t *testing.T) {
	firstRunHome(t)
	srv := startOrchard(t)
	stubPrompt(t, true, answer(srv.URL+"/"))
	if err := execLogin(t, "--token", "orch_first"); err != nil {
		t.Fatal(err)
	}
	f, err := config.LoadFile()
	if err != nil {
		t.Fatal(err)
	}
	e, ok := f.Contexts[f.Current]
	if !ok || len(f.Contexts) != 1 || e.APIURL != srv.URL || e.Token != "orch_first" {
		t.Fatalf("unexpected contexts: %+v", f)
	}
}

func TestFirstLoginCancelSavesNothing(t *testing.T) {
	home := firstRunHome(t)
	stubPrompt(t, true, func(context.Context, tui.InstanceCheck) (string, bool, error) { return "", false, nil })
	if err := execLogin(t, "--token", "orch_x"); err == nil || !strings.Contains(err.Error(), "aborted") {
		t.Fatalf("err = %v, want aborted", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".orchard", "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config written after cancel: %v", err)
	}
}

func TestFirstCommandContinuesIntoSignIn(t *testing.T) {
	firstRunHome(t)
	srv := startOrchard(t)
	stubPrompt(t, true, answer(srv.URL))
	old := browserLogin
	t.Cleanup(func() { browserLogin = old })
	signedIn := ""
	browserLogin = func(cfg *config.Config, base string, _ bool) error {
		signedIn = base
		cfg.Token = "orch_browser"
		return cfg.Save()
	}
	_, cfg, err := client()
	if err != nil {
		t.Fatal(err)
	}
	if signedIn != srv.URL || cfg.Token != "orch_browser" {
		t.Fatalf("signedIn = %q, cfg = %+v", signedIn, cfg)
	}
}

func TestFirstCommandWithEnvTokenNeverStoresIt(t *testing.T) {
	firstRunHome(t)
	t.Setenv("ORCHARD_API_TOKEN", "orch_env")
	srv := startOrchard(t)
	stubPrompt(t, true, answer(srv.URL))
	old := browserLogin
	t.Cleanup(func() { browserLogin = old })
	browserLogin = func(*config.Config, string, bool) error {
		t.Fatal("signed in despite ORCHARD_API_TOKEN")
		return nil
	}
	_, cfg, err := client()
	if err != nil {
		t.Fatal(err)
	}
	f, _ := config.LoadFile()
	if cfg.Token != "orch_env" || f.Contexts[cfg.Name].Token != "" {
		t.Fatalf("cfg = %+v, file = %+v", cfg, f.Contexts)
	}
}

func TestSavedContextIsNeitherPromptedNorProbed(t *testing.T) {
	home := firstRunHome(t)
	var health int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/health" {
			health++
		}
		_, _ = w.Write([]byte(`{"email":"a@example.com"}`))
	}))
	t.Cleanup(srv.Close)
	writeConfig(t, home, `{"apiUrl":"`+srv.URL+`","token":"orch_old","context":{"orgSlug":"acme"}}`)
	stubPrompt(t, true, neverAsk(t))
	if err := execLogin(t, "--token", "orch_new"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if health != 0 || cfg.APIURL != srv.URL || cfg.Token != "orch_new" || cfg.Context.OrgSlug != "acme" {
		t.Fatalf("health probes = %d, cfg = %+v", health, cfg)
	}
}

func TestLoginWithEnvURLLeavesCurrentContextAlone(t *testing.T) {
	home := firstRunHome(t)
	writeConfig(t, home, `{"current":"acme","contexts":{"acme":{"apiUrl":"https://orchard.acme.dev","token":"orch_acme"}}}`)
	srv := startOrchard(t)
	t.Setenv("ORCHARD_API_URL", srv.URL)
	stubPrompt(t, false, neverAsk(t))
	if err := execLogin(t, "--token", "orch_new"); err != nil {
		t.Fatal(err)
	}
	f, _ := config.LoadFile()
	if e := f.Contexts["acme"]; e.APIURL != "https://orchard.acme.dev" || e.Token != "orch_acme" || len(f.Contexts) != 2 {
		t.Fatalf("current context overwritten: %+v", f.Contexts)
	}
}

func TestLoginRejectsAHostThatIsNotOrchard(t *testing.T) {
	home := firstRunHome(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(srv.Close)
	stubPrompt(t, false, neverAsk(t))
	err := execLogin(t, "--token", "orch_x", "--api-url", srv.URL)
	if err == nil || !strings.Contains(err.Error(), "doesn't look like an Orchard instance") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".orchard", "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config written for a rejected host: %v", err)
	}
}

func TestDamagedConfigIsNotTreatedAsFirstRun(t *testing.T) {
	home := firstRunHome(t)
	p := writeConfig(t, home, `{not json`)
	stubPrompt(t, true, neverAsk(t))
	if err := execLogin(t, "--token", "orch_x"); err == nil || !strings.Contains(err.Error(), "config.json") {
		t.Fatalf("err = %v, want it to name the config file", err)
	}
	data, _ := os.ReadFile(p)
	if string(data) != `{not json` {
		t.Fatalf("damaged config rewritten: %s", data)
	}
}

func TestSigningOutWithNothingConfiguredWritesNothing(t *testing.T) {
	home := firstRunHome(t)
	c := authLogoutCmd()
	c.SetArgs(nil)
	if err := c.Execute(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".orchard", "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("logout created a config: %v", err)
	}
}

func TestTokenlessCommandsAskWithoutSigningIn(t *testing.T) {
	firstRunHome(t)
	srv := startOrchard(t)
	stubPrompt(t, true, answer(srv.URL))
	old := browserLogin
	t.Cleanup(func() { browserLogin = old })
	browserLogin = func(*config.Config, string, bool) error {
		t.Fatal("signed in for a tokenless command")
		return nil
	}
	cfg, err := instanceConfig(context.Background())
	if err != nil || cfg.APIURL != srv.URL {
		t.Fatalf("cfg = %+v, err = %v", cfg, err)
	}
}
