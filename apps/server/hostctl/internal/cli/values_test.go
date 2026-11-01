package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "values.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSetKeepsScalarTypes(t *testing.T) {
	v, err := LoadValues(write(t, "a: 1\n"))
	if err != nil {
		t.Fatal(err)
	}
	v.Set("metrics.enabled", "true")
	v.Set("server.replicas", "3")
	v.Set("signupMode", "invite_only")

	if got := v.Get("metrics.enabled"); got != true {
		t.Fatalf("expected bool true, got %#v", got)
	}
	if got := v.Get("server.replicas"); got != 3 {
		t.Fatalf("expected int 3, got %#v", got)
	}
	if got := v.Get("signupMode"); got != "invite_only" {
		t.Fatalf("expected string, got %#v", got)
	}
}

func TestGetMissingPathIsNilNotAPanic(t *testing.T) {
	v, _ := LoadValues(write(t, "a: 1\n"))
	if got := v.Get("no.such.path"); got != nil {
		t.Fatalf("expected nil, got %#v", got)
	}
	if got := v.Get("a.b.c"); got != nil {
		t.Fatalf("scalar traversal should be nil, got %#v", got)
	}
}

func TestUnsetLeavesSiblingsAlone(t *testing.T) {
	v, _ := LoadValues(write(t, "builders:\n  enabled: true\n  cache: big\n"))
	v.Unset("builders.cache")
	if v.Get("builders.cache") != nil {
		t.Fatal("cache should be gone")
	}
	if v.Get("builders.enabled") != true {
		t.Fatal("sibling should survive")
	}
}

func TestSaveKeepsTheFilePrivate(t *testing.T) {
	path := write(t, "a: 1\n")
	v, _ := LoadValues(path)
	v.Set("b", "2")
	if err := v.Save(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// The values file holds credentials; widening it on rewrite would leak them.
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("expected 0600, got %o", perm)
	}
}

func TestRoundTripsThroughDisk(t *testing.T) {
	path := write(t, "signupMode: closed\n")
	v, _ := LoadValues(path)
	v.Set("signupMode", "open")
	if err := v.Save(); err != nil {
		t.Fatal(err)
	}
	again, err := LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.Get("signupMode"); got != "open" {
		t.Fatalf("expected open, got %#v", got)
	}
}

func TestEmptyFileIsUsable(t *testing.T) {
	v, err := LoadValues(write(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	v.Set("a.b", "c")
	if got := v.Get("a.b"); got != "c" {
		t.Fatalf("expected c, got %#v", got)
	}
}

// A container env list takes the last definition of a name, so an upsert that
// appends rather than replaces leaves the old value in place above it.
func TestSetEnvReplacesRatherThanAppends(t *testing.T) {
	v, err := LoadValues(write(t, "server:\n  env:\n    - {name: A, value: one}\n    - {name: B, value: two}\n"))
	if err != nil {
		t.Fatal(err)
	}
	v.SetEnv("server.env", "A", "changed")
	v.SetEnv("server.env", "C", "new")

	if got := v.EnvValue("server.env", "A"); got != "changed" {
		t.Fatalf("expected changed, got %q", got)
	}
	if got := v.EnvValue("server.env", "B"); got != "two" {
		t.Fatalf("other entries must survive, got %q", got)
	}
	if got := len(v.List("server.env")); got != 3 {
		t.Fatalf("expected 3 entries, got %d", got)
	}
}

func TestEnvValueOnMissingPathIsEmpty(t *testing.T) {
	v, err := LoadValues(write(t, "a: 1\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := v.EnvValue("mcp.env", "JWT_SECRET"); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
	v.SetEnv("mcp.env", "JWT_SECRET", "x")
	if got := v.EnvValue("mcp.env", "JWT_SECRET"); got != "x" {
		t.Fatalf("SetEnv should create the list, got %q", got)
	}
}

func TestSetRefusesToWalkThroughAList(t *testing.T) {
	v, err := LoadValues(write(t, "server:\n  env:\n    - {name: JWT_SECRET, value: keep}\n    - {name: SECRETS_ENCRYPTION_KEY, value: keep-too}\n"))
	if err != nil {
		t.Fatal(err)
	}
	err = v.Set("server.env.SMTP_HOST", "smtp.example.com")
	var listErr *ListPathError
	if !errors.As(err, &listErr) {
		t.Fatalf("expected a ListPathError, got %v", err)
	}
	if listErr.List != "server.env" {
		t.Fatalf("expected the list to be named, got %q", listErr.List)
	}
	if !strings.Contains(err.Error(), "orchardctl env set") {
		t.Fatalf("the error should point at orchardctl env, got %q", err)
	}
	if got := v.EnvValue("server.env", "SECRETS_ENCRYPTION_KEY"); got != "keep-too" {
		t.Fatalf("the env list must survive, got %q", got)
	}
}

func TestSetRefusesToReplaceAListWithAScalar(t *testing.T) {
	v, _ := LoadValues(write(t, "server:\n  env:\n    - {name: JWT_SECRET, value: keep}\n"))
	if err := v.Set("server.env", "oops"); err == nil {
		t.Fatal("replacing the env list with a string should be refused")
	}
	if got := len(v.List("server.env")); got != 1 {
		t.Fatalf("expected the list untouched, got %d entries", got)
	}
}

func TestPutStillReplacesAListWithAList(t *testing.T) {
	v, _ := LoadValues(write(t, "builders:\n  harbor:\n    hosts: [a, b]\n"))
	if err := v.Put("builders.harbor.hosts", []any{"c"}); err != nil {
		t.Fatal(err)
	}
	if got := v.List("builders.harbor.hosts"); len(got) != 1 || got[0] != "c" {
		t.Fatalf("expected [c], got %#v", got)
	}
}

func TestUnsetEnvRemovesOnlyThatEntry(t *testing.T) {
	v, _ := LoadValues(write(t, "server:\n  env:\n    - {name: A, value: one}\n    - {name: B, value: two}\n"))
	if !v.UnsetEnv("server.env", "A") {
		t.Fatal("A should have been removed")
	}
	if v.UnsetEnv("server.env", "A") {
		t.Fatal("a second unset should report nothing removed")
	}
	if names := v.EnvNames("server.env"); len(names) != 1 || names[0] != "B" {
		t.Fatalf("expected only B left, got %v", names)
	}
}
