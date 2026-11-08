package config

import (
	"os"
	"path/filepath"
	"testing"
)

func withHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORCHARD_API_URL", "")
	t.Setenv("ORCHARD_API_TOKEN", "")
	t.Setenv("ORCHARD_CONTEXT", "")
	Override = ""
	return home
}

func TestLegacyConfigBecomesOneContext(t *testing.T) {
	home := withHome(t)
	dir := filepath.Join(home, ".orchard")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"apiUrl":"https://orchard.acme.dev","token":"orch_old","context":{"orgSlug":"acme"}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Name != "orchard.acme.dev" || cfg.Token != "orch_old" || cfg.Context.OrgSlug != "acme" {
		t.Fatalf("legacy config not migrated: %+v", cfg)
	}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	f, _ := LoadFile()
	if f.Current != "orchard.acme.dev" || len(f.Contexts) != 1 {
		t.Fatalf("unexpected file after save: %+v", f)
	}
}

func TestSigningInToASecondInstanceAddsAContextAndSwitches(t *testing.T) {
	withHome(t)
	first := &Config{APIURL: "https://orchard.acme.dev", Token: "orch_a"}
	if err := first.Save(); err != nil {
		t.Fatal(err)
	}
	cfg, _ := Load()
	second, err := cfg.ForInstance("https://orchard.hackclub.dev/", "")
	if err != nil {
		t.Fatal(err)
	}
	second.Token = "orch_b"
	if err := second.Save(); err != nil {
		t.Fatal(err)
	}
	f, _ := LoadFile()
	if len(f.Contexts) != 2 || f.Current != "orchard.hackclub.dev" {
		t.Fatalf("expected two contexts with the new one current: %+v", f)
	}
	if f.Contexts["orchard.acme.dev"].Token != "orch_a" {
		t.Fatal("the first instance's token must survive")
	}

	again, _ := (&Config{Name: "orchard.hackclub.dev", APIURL: "https://orchard.hackclub.dev"}).ForInstance("https://orchard.acme.dev", "")
	if again.Name != "orchard.acme.dev" || again.Token != "orch_a" {
		t.Fatalf("signing in again reuses the existing context: %+v", again)
	}
}

func TestOverrideAndEnvPickTheContextForOneCommand(t *testing.T) {
	withHome(t)
	f := &File{Current: "a", Contexts: map[string]Entry{
		"a": {APIURL: "https://a.example", Token: "orch_a"},
		"b": {APIURL: "https://b.example", Token: "orch_b"},
	}}
	if err := f.Save(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORCHARD_CONTEXT", "b")
	cfg, _ := Load()
	if cfg.APIURL != "https://b.example" {
		t.Fatalf("ORCHARD_CONTEXT ignored: %+v", cfg)
	}
	Override = "a"
	cfg, _ = Load()
	if cfg.APIURL != "https://a.example" {
		t.Fatalf("--context should beat the env: %+v", cfg)
	}
	Override = "missing"
	if _, err := Load(); err == nil {
		t.Fatal("an unknown context must be an error, not a silent fallback")
	}
	Override = ""
}

func TestNamedContextMustNotPointElsewhere(t *testing.T) {
	withHome(t)
	if err := (&Config{Name: "work", APIURL: "https://a.example"}).Save(); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Config{}).ForInstance("https://b.example", "work"); err == nil {
		t.Fatal("reusing a name for a different instance must fail")
	}
	if _, err := (&Config{}).ForInstance("https://b.example", "bad name"); err == nil {
		t.Fatal("invalid names must fail")
	}
}

func TestNameForURL(t *testing.T) {
	cases := map[string]string{
		"https://orchard.acme.dev":    "orchard.acme.dev",
		"http://localhost:4000":       "localhost-4000",
		"https://www.example.com/api": "example.com",
		"not a url":                   "default",
	}
	for in, want := range cases {
		if got := NameForURL(in); got != want {
			t.Errorf("NameForURL(%q) = %q, want %q", in, got, want)
		}
	}
}
