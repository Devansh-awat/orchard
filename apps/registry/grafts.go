package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const graftCatalogKey = "grafts/index.json"

var graftIDRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,47}$`)

type graftDoc struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Publisher    string            `json:"publisher"`
	Description  string            `json:"description"`
	Homepage     string            `json:"homepage"`
	Icon         string            `json:"icon"`
	Engines      map[string]string `json:"engines"`
	Capabilities []string          `json:"capabilities"`
	Uses         map[string]int    `json:"uses"`
	Claims       map[string]any    `json:"claims"`
	Database     map[string]any    `json:"database"`
	Public       map[string]any    `json:"public"`
}

type graftArtifact struct {
	doc      graftDoc
	raw      []byte
	manifest []byte
	readme   []byte
	icon     []byte
	iconExt  string
	signed   bool
	source   string
}

type graftVersion struct {
	Version      string            `json:"version"`
	Digest       string            `json:"digest"`
	URL          string            `json:"url"`
	Size         int               `json:"size"`
	Signed       bool              `json:"signed"`
	Engines      map[string]string `json:"engines"`
	Capabilities []string          `json:"capabilities"`
	Manifest     string            `json:"manifest"`
	Readme       string            `json:"readme,omitempty"`
	PublishedAt  string            `json:"publishedAt"`
}

type graftIndex struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Publisher   string         `json:"publisher"`
	Homepage    string         `json:"homepage,omitempty"`
	Icon        string         `json:"icon,omitempty"`
	Latest      string         `json:"latest"`
	Versions    []graftVersion `json:"versions"`
}

type graftCatalog struct {
	GeneratedAt string       `json:"generatedAt"`
	Grafts      []graftIndex `json:"grafts"`
	Revoked     []string     `json:"revoked"`
}

func readGraftArtifact(path string) (graftArtifact, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return graftArtifact{}, err
	}
	a := graftArtifact{raw: raw, source: path}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return a, fmt.Errorf("%s is not a .graft: %w", path, err)
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return a, fmt.Errorf("%s: %w", path, err)
		}
		switch hdr.Name {
		case "graft.json":
			a.manifest, err = io.ReadAll(tr)
			if err == nil {
				err = json.Unmarshal(a.manifest, &a.doc)
			}
		case "README.md":
			a.readme, err = io.ReadAll(tr)
		case "MANIFEST.sig":
			a.signed = true
		default:
			if strings.HasPrefix(hdr.Name, "assets/icon.") {
				a.iconExt = filepath.Ext(hdr.Name)
				a.icon, err = io.ReadAll(tr)
			}
		}
		if err != nil {
			return a, fmt.Errorf("%s: %s: %w", path, hdr.Name, err)
		}
	}
	switch {
	case a.manifest == nil:
		return a, fmt.Errorf("%s has no graft.json", path)
	case !graftIDRe.MatchString(a.doc.ID):
		return a, fmt.Errorf("%s: invalid graft id %q", path, a.doc.ID)
	case !semverRe.MatchString(a.doc.Version):
		return a, fmt.Errorf("%s: invalid version %q", path, a.doc.Version)
	case a.doc.Engines["platform"] == "" || a.doc.Engines["sdk"] == "":
		return a, fmt.Errorf("%s: engines.platform and engines.sdk are required", path)
	}
	return a, nil
}

func loadGraftArtifacts(dirs []string) ([]graftArtifact, error) {
	var out []graftArtifact
	for _, dir := range dirs {
		matches, err := filepath.Glob(filepath.Join(dir, "*.graft"))
		if err != nil {
			return nil, err
		}
		for _, m := range matches {
			a, err := readGraftArtifact(m)
			if err != nil {
				return nil, err
			}
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].doc.ID != out[j].doc.ID {
			return out[i].doc.ID < out[j].doc.ID
		}
		return compareSemver(out[i].doc.Version, out[j].doc.Version) < 0
	})
	return out, nil
}

func loadRevoked(path string) ([]string, error) {
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, "sha256:") {
			line = "sha256:" + line
		}
		out = append(out, strings.ToLower(line))
	}
	return out, nil
}

func (p *publisher) readGraftIndex(ctx context.Context, id string) (*graftIndex, error) {
	raw, err := p.bucket.ReadAll(ctx, p.key("grafts/"+id+"/index.json"))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var idx graftIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("grafts/%s/index.json is unreadable: %w", id, err)
	}
	return &idx, nil
}

func (p *publisher) publishGraft(ctx context.Context, publicBase string, a graftArtifact) (graftIndex, error) {
	d := a.doc
	base := "grafts/" + d.ID + "/" + d.Version + "/"
	artifactKey := base + d.ID + "-" + d.Version + ".graft"
	if _, err := p.putIfChanged(ctx, artifactKey, a.raw, "application/gzip", cacheImmutable, true); err != nil {
		return graftIndex{}, err
	}
	if _, err := p.putIfChanged(ctx, base+"graft.json", a.manifest, "application/json; charset=utf-8", cacheImmutable, true); err != nil {
		return graftIndex{}, err
	}
	readmeKey := ""
	if a.readme != nil {
		readmeKey = base + "README.md"
		if _, err := p.putIfChanged(ctx, readmeKey, a.readme, "text/markdown; charset=utf-8", cacheImmutable, true); err != nil {
			return graftIndex{}, err
		}
	}
	iconKey := ""
	if a.icon != nil {
		iconKey = base + "icon" + a.iconExt
		if _, err := p.putIfChanged(ctx, iconKey, a.icon, contentTypeFor(iconKey, ""), cacheImmutable, true); err != nil {
			return graftIndex{}, err
		}
	}
	prior, err := p.readGraftIndex(ctx, d.ID)
	if err != nil {
		return graftIndex{}, err
	}
	versions := map[string]graftVersion{}
	if prior != nil {
		for _, v := range prior.Versions {
			versions[v.Version] = v
		}
	}
	current := graftVersion{
		Version:      d.Version,
		Digest:       "sha256:" + sha256Hex(a.raw),
		URL:          strings.TrimSuffix(publicBase, "/") + "/" + artifactKey,
		Size:         len(a.raw),
		Signed:       a.signed,
		Engines:      d.Engines,
		Capabilities: nonNil(d.Capabilities),
		Manifest:     base + "graft.json",
		Readme:       readmeKey,
		PublishedAt:  p.now().UTC().Format(time.RFC3339),
	}
	if existing, ok := versions[d.Version]; ok {
		if existing.Digest != current.Digest {
			return graftIndex{}, fmt.Errorf("%s %s is already published with different content; bump the version", d.ID, d.Version)
		}
		current.PublishedAt = existing.PublishedAt
	}
	versions[d.Version] = current
	idx := graftIndex{ID: d.ID, Name: firstNonEmpty(d.Name, d.ID), Description: d.Description, Publisher: d.Publisher, Homepage: d.Homepage, Icon: iconKey}
	for _, v := range versions {
		idx.Versions = append(idx.Versions, v)
	}
	sort.Slice(idx.Versions, func(i, j int) bool { return compareSemver(idx.Versions[i].Version, idx.Versions[j].Version) > 0 })
	idx.Latest = idx.Versions[0].Version
	body, _ := json.MarshalIndent(idx, "", "  ")
	if _, err := p.putIfChanged(ctx, "grafts/"+d.ID+"/index.json", body, "application/json; charset=utf-8", cacheIndex, false); err != nil {
		return graftIndex{}, err
	}
	return idx, nil
}

func (p *publisher) runGrafts(ctx context.Context, dirs []string, publicBase, revokedFile string) (*graftCatalog, error) {
	artifacts, err := loadGraftArtifacts(dirs)
	if err != nil {
		return nil, err
	}
	revoked, err := loadRevoked(revokedFile)
	if err != nil {
		return nil, err
	}
	byID := map[string]graftIndex{}
	existing, err := p.bucket.ReadAll(ctx, p.key(graftCatalogKey))
	switch {
	case errors.Is(err, ErrNotFound):
	case err != nil:
		return nil, err
	default:
		var prior graftCatalog
		if err := json.Unmarshal(existing, &prior); err != nil {
			return nil, fmt.Errorf("%s is unreadable: %w", graftCatalogKey, err)
		}
		for _, g := range prior.Grafts {
			byID[g.ID] = g
		}
		revoked = append(revoked, prior.Revoked...)
	}
	for _, a := range artifacts {
		idx, err := p.publishGraft(ctx, publicBase, a)
		if err != nil {
			return nil, err
		}
		byID[idx.ID] = idx
		p.log.Printf("published graft %-20s %s", a.doc.ID, a.doc.Version)
	}
	cat := &graftCatalog{GeneratedAt: p.now().UTC().Format(time.RFC3339), Grafts: []graftIndex{}, Revoked: dedupe(revoked)}
	for _, g := range byID {
		cat.Grafts = append(cat.Grafts, g)
	}
	sort.Slice(cat.Grafts, func(i, j int) bool { return cat.Grafts[i].ID < cat.Grafts[j].ID })
	body, _ := json.MarshalIndent(cat, "", "  ")
	if _, err := p.putIfChanged(ctx, graftCatalogKey, body, "application/json; charset=utf-8", cacheIndex, false); err != nil {
		return nil, err
	}
	return cat, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

func validateGrafts(dirs []string) error {
	artifacts, err := loadGraftArtifacts(dirs)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, a := range artifacts {
		key := a.doc.ID + "@" + a.doc.Version
		if seen[key] {
			return fmt.Errorf("%s is packed twice", key)
		}
		seen[key] = true
		signed := "unsigned"
		if a.signed {
			signed = "signed"
		}
		fmt.Printf("ok %-24s %-10s %s\n", a.doc.ID, a.doc.Version, signed)
	}
	return nil
}
