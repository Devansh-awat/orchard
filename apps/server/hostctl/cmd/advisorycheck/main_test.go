package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/commands"
)

func TestFindRootWalksUp(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "install"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "install", "install.sh"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(root, "apps", "server", "hostctl")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := findRoot(deep)
	if err != nil || got != root {
		t.Errorf("got %q %v", got, err)
	}
	if _, err := findRoot(t.TempDir()); err == nil {
		t.Error("a directory outside the repository should fail")
	}
}

func TestRunWritesMarkdownAndExits(t *testing.T) {
	md := filepath.Join(t.TempDir(), "report.md")
	var stdout, stderr bytes.Buffer
	var checked string
	code := run([]string{"-root", "/repo", "-markdown", md}, &stdout, &stderr, func(root string) (commands.ShippedReport, error) {
		checked = root
		return commands.ShippedReport{}, nil
	})
	if code != commands.ShippedClean || checked != "/repo" {
		t.Errorf("code %d root %q stderr %s", code, checked, stderr.String())
	}
	raw, err := os.ReadFile(md)
	if err != nil || !strings.Contains(string(raw), "No shipped component has a known advisory.") {
		t.Errorf("markdown %q %v", raw, err)
	}
	code = run([]string{"-root", "/repo"}, &stdout, &stderr, func(string) (commands.ShippedReport, error) {
		return commands.ShippedReport{}, errors.New("no values file")
	})
	if code != 2 || !strings.Contains(stderr.String(), "no values file") {
		t.Errorf("code %d stderr %s", code, stderr.String())
	}
}
