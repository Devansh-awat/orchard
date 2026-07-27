package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFindBuildConfigReadsFields(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, BuildConfigFileName), `{
		"framework": "vite",
		"rootDirectory": "apps/web/",
		"buildCommand": "pnpm build",
		"outputDirectory": "dist",
		"port": 8080
	}`)

	cfg, found, ok := FindBuildConfig(dir)
	if !ok {
		t.Fatal("expected to find orchard.json")
	}
	if found != dir {
		t.Errorf("found dir = %q, want %q", found, dir)
	}
	if cfg.Framework != "vite" {
		t.Errorf("framework = %q", cfg.Framework)
	}
	if cfg.RootDirectory != "apps/web" {
		t.Errorf("rootDirectory = %q, want trailing slash trimmed", cfg.RootDirectory)
	}
	if cfg.BuildCommand != "pnpm build" || cfg.OutputDirectory != "dist" || cfg.Port != 8080 {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestFindBuildConfigWalksUpToRepoRoot(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".git", "config"), "")
	writeFile(t, filepath.Join(root, BuildConfigFileName), `{"buildCommand":"make"}`)
	nested := filepath.Join(root, "apps", "web", "src")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	cfg, _, ok := FindBuildConfig(nested)
	if !ok || cfg.BuildCommand != "make" {
		t.Fatalf("expected to walk up to the repo root, got ok=%v cfg=%+v", ok, cfg)
	}
}

func TestFindBuildConfigStopsAtRepoRoot(t *testing.T) {
	// A config belonging to a parent project must not leak into this repo.
	outer := t.TempDir()
	writeFile(t, filepath.Join(outer, BuildConfigFileName), `{"buildCommand":"not mine"}`)
	repo := filepath.Join(outer, "inner")
	writeFile(t, filepath.Join(repo, ".git", "config"), "")

	if _, _, ok := FindBuildConfig(repo); ok {
		t.Error("orchard.json above the repo root should be ignored")
	}
}

func TestFindBuildConfigIgnoresMalformedFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, BuildConfigFileName), "{ not json")

	if _, _, ok := FindBuildConfig(dir); ok {
		t.Error("a malformed orchard.json should not block a deploy that works from flags")
	}
}

func TestFindBuildConfigAbsentIsNotAnError(t *testing.T) {
	if _, _, ok := FindBuildConfig(t.TempDir()); ok {
		t.Error("expected no config")
	}
}
