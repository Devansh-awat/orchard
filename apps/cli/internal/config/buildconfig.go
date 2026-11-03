package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// BuildConfig is the optional orchard.json a repository can commit to describe
// how it should be built. Every field is a default: an explicit CLI flag beats
// the file, and a railpack.json in the repo still beats everything, because
// Railpack merges its own config last.
//
// Unset fields mean "let Railpack detect it", which is the point of the file
// existing at all: you only write down the parts detection gets wrong.
type BuildConfig struct {
	Framework       string `json:"framework,omitempty"`
	RootDirectory   string `json:"rootDirectory,omitempty"`
	InstallCommand  string `json:"installCommand,omitempty"`
	BuildCommand    string `json:"buildCommand,omitempty"`
	StartCommand    string `json:"startCommand,omitempty"`
	OutputDirectory string `json:"outputDirectory,omitempty"`
	Port            int    `json:"port,omitempty"`
	Dockerfile      string `json:"dockerfile,omitempty"`
}

// BuildConfigFileName is the file the CLI and server both look for.
const BuildConfigFileName = "orchard.json"

// FindBuildConfig walks up from start looking for orchard.json, stopping at the
// repository root so a file belonging to a parent project is never picked up.
// Mirrors FindLink's containment rules deliberately: the two files describe the
// same directory and should agree on what "this project" means.
//
// Returns the parsed config and the directory it was found in.
func FindBuildConfig(start string) (*BuildConfig, string, bool) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return nil, "", false
	}
	home, _ := os.UserHomeDir()

	for {
		if cfg, ok := readBuildConfig(dir); ok {
			return cfg, dir, true
		}
		// Stop at the repo root: an orchard.json above it describes something else.
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return nil, "", false
		}
		parent := filepath.Dir(dir)
		if parent == dir || dir == home {
			return nil, "", false
		}
		dir = parent
	}
}

func readBuildConfig(dir string) (*BuildConfig, bool) {
	data, err := os.ReadFile(filepath.Join(dir, BuildConfigFileName))
	if err != nil {
		return nil, false
	}
	var cfg BuildConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		// A malformed orchard.json is worth surfacing, but not worth blocking a
		// deploy that would otherwise work from flags and detection.
		return nil, false
	}
	cfg.RootDirectory = strings.Trim(strings.TrimSpace(cfg.RootDirectory), "/")
	return &cfg, true
}
