package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeAPIURL(t *testing.T) {
	tests := []struct{ in, want string }{
		{"orchard.example.com", "https://orchard.example.com"},
		{"  https://Orchard.Example.com/  ", "https://orchard.example.com"},
		{"https://orchard.example.com/apiv1", "https://orchard.example.com"},
		{"https://orchard.example.com/apiv1/", "https://orchard.example.com"},
		{"https://orchard.example.com:443", "https://orchard.example.com"},
		{"http://orchard.example.com:80", "http://orchard.example.com"},
		{"https://orchard.example.com:8443", "https://orchard.example.com:8443"},
		{"localhost:4000", "http://localhost:4000"},
		{"127.0.0.1:4000", "http://127.0.0.1:4000"},
		{"[::1]:4000", "http://[::1]:4000"},
		{"http://10.0.0.2:8080", "http://10.0.0.2:8080"},
	}
	for _, tt := range tests {
		got, err := NormalizeAPIURL(tt.in)
		if err != nil || got != tt.want {
			t.Errorf("NormalizeAPIURL(%q) = %q, %v, want %q", tt.in, got, err, tt.want)
		}
	}
}

func TestNormalizeAPIURLRejects(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", "enter the URL"},
		{"   ", "enter the URL"},
		{"ftp://orchard.example.com", "http:// or https://"},
		{"https://", "no hostname"},
		{"https://user:pw@orchard.example.com", "username and password"},
		{"https://orchard.example.com:99999", "out of range"},
		{"https://orchard.example.com/projects/x", "base URL, like https://orchard.example.com"},
		{"https://orchard.example.com/?a=1", "base URL"},
		{"https://orchard.example.com/#x", "base URL"},
		{"https://exa mple.com", "invalid Orchard URL"},
	}
	for _, tt := range tests {
		if _, err := NormalizeAPIURL(tt.in); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("NormalizeAPIURL(%q) err = %v, want it to contain %q", tt.in, err, tt.want)
		}
	}
}

func TestNothingConfiguredHasNoInstance(t *testing.T) {
	withHome(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HasInstance() || cfg.APIURL != "" || DefaultAPIURL != "" {
		t.Fatalf("expected no built-in instance, got %+v (default %q)", cfg, DefaultAPIURL)
	}
}

func TestSavedHackClubContextKeepsWorkingUntouched(t *testing.T) {
	home := withHome(t)
	dir := filepath.Join(home, ".orchard")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "config.json")
	legacy := `{"apiUrl":"https://orchard.infra.hackclub.com","token":"orch_old"}`
	if err := os.WriteFile(p, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIURL != "https://orchard.infra.hackclub.com" || cfg.Token != "orch_old" {
		t.Fatalf("saved instance lost: %+v", cfg)
	}
	data, _ := os.ReadFile(p)
	if string(data) != legacy {
		t.Fatalf("loading rewrote the config: %s", data)
	}
}

func TestDamagedConfigIsAnError(t *testing.T) {
	home := withHome(t)
	dir := filepath.Join(home, ".orchard")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{nope`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "config.json") {
		t.Fatalf("Load err = %v", err)
	}
	if err := (&Config{APIURL: "https://a.example", Token: "t"}).Save(); err == nil {
		t.Fatal("Save overwrote a damaged config")
	}
}

func TestFindByURLIgnoresHostCase(t *testing.T) {
	withHome(t)
	if err := (&Config{APIURL: "https://Orchard.Acme.dev/", Token: "t"}).Save(); err != nil {
		t.Fatal(err)
	}
	f, _ := LoadFile()
	if _, ok := f.FindByURL("https://orchard.acme.dev"); !ok {
		t.Fatal("expected a case-insensitive match")
	}
}

func TestForInstanceIgnoresAnEnvOverrideOfTheCurrentContext(t *testing.T) {
	withHome(t)
	if err := (&Config{APIURL: "https://a.example", Token: "orch_a"}).Save(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORCHARD_API_URL", "https://b.example")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	next, err := cfg.ForInstance("https://b.example", "")
	if err != nil {
		t.Fatal(err)
	}
	if next.Name == cfg.Name || next.Token != "" {
		t.Fatalf("env override reused the current context: %+v", next)
	}
}
