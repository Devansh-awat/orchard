package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Link is the per-directory scope written by `orchard link` into
// .orchard/project.json next to the code it describes. IDs are what the API
// wants; slugs are display-only. No token is ever stored here, so the file is
// safe to share between machines (it is still gitignored by default because
// teammates may link different projects).
type Link struct {
	OrgID       string `json:"orgId,omitempty"`
	OrgSlug     string `json:"orgSlug,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectSlug string `json:"projectSlug,omitempty"`
	EnvID       string `json:"envId,omitempty"`
	EnvName     string `json:"envName,omitempty"`
}

const (
	linkDirName  = ".orchard"
	linkFileName = "project.json"
)

// LinkPath returns the link file path under dir.
func LinkPath(dir string) string {
	return filepath.Join(dir, linkDirName, linkFileName)
}

// FindLink walks up from start looking for .orchard/project.json. The walk
// stops after the first directory that contains .git (the repo root) so a
// link outside the current repository is never picked up, and never ascends
// past the user's home directory or the filesystem root.
func FindLink(start string) (*Link, string, bool) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return nil, "", false
	}
	home, _ := os.UserHomeDir()

	for {
		if l, ok := readLink(dir); ok {
			return l, dir, true
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return nil, "", false
		}
		if home != "" && dir == home {
			return nil, "", false
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, "", false
		}
		dir = parent
	}
}

func readLink(dir string) (*Link, bool) {
	data, err := os.ReadFile(LinkPath(dir))
	if err != nil {
		return nil, false
	}
	l := &Link{}
	if err := json.Unmarshal(data, l); err != nil {
		return nil, false
	}
	if l.ProjectID == "" && l.OrgID == "" {
		return nil, false
	}
	return l, true
}

// WriteLink writes .orchard/project.json under dir and returns the file path.
func WriteLink(dir string, l *Link) (string, error) {
	d := filepath.Join(dir, linkDirName)
	if err := os.MkdirAll(d, 0o755); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return "", err
	}
	p := filepath.Join(d, linkFileName)
	if err := os.WriteFile(p, append(data, '\n'), 0o644); err != nil {
		return "", err
	}
	return p, nil
}

// RemoveLink deletes .orchard/project.json under dir, pruning the .orchard
// directory when that leaves it empty.
func RemoveLink(dir string) error {
	if err := os.Remove(LinkPath(dir)); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(dir, linkDirName))
	return nil
}
