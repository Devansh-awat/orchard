package cli

import (
	"os"
	"path/filepath"
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
