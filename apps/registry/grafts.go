package main

import (
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
	files    map[string][]byte
}

type graftMeta struct {
	Tier           string
	Repo           string
	PublisherKeyID string
	Publisher      string
	Homepage       string
}

const (
	tierOfficial  = "official"
	tierCommunity = "community"
	tierDelisted  = "delisted"
)

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
	Revoked      bool              `json:"revoked,omitempty"`
}

type graftIndex struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Description    string         `json:"description"`
	Publisher      string         `json:"publisher"`
	Homepage       string         `json:"homepage,omitempty"`
	Icon           string         `json:"icon,omitempty"`
	Tier           string         `json:"tier"`
	Repo           string         `json:"repo,omitempty"`
	PublisherKeyID string         `json:"publisherKeyId,omitempty"`
	Latest         string         `json:"latest"`
	Versions       []graftVersion `json:"versions"`
}

func (g graftIndex) tier() string {
	if g.Tier == "" {
		return tierOfficial
	}
	return g.Tier
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
	return parseGraftArtifact(raw, path)
}

func parseGraftArtifact(raw []byte, source string) (graftArtifact, error) {
	a := graftArtifact{raw: raw, source: source}
	files, err := untarGraft(raw)
	if err != nil {
		return a, fmt.Errorf("%s is not a usable .graft: %w", source, err)
	}
	a.files = files
	a.manifest, a.readme = files["graft.json"], files["README.md"]
	_, a.signed = files["MANIFEST.sig"]
	var icons []string
	for name := range files {
		if strings.HasPrefix(name, "assets/icon.") {
			icons = append(icons, name)
		}
	}
	sort.Strings(icons)
	if len(icons) > 0 {
		a.iconExt = filepath.Ext(icons[0])
		a.icon = files[icons[0]]
	}
	if a.manifest == nil {
		return a, fmt.Errorf("%s has no graft.json", source)
	}
	if err := json.Unmarshal(a.manifest, &a.doc); err != nil {
		return a, fmt.Errorf("%s: graft.json: %w", source, err)
	}
	switch {
	case !graftIDRe.MatchString(a.doc.ID):
		return a, fmt.Errorf("%s: invalid graft id %q", source, a.doc.ID)
	case !semverRe.MatchString(a.doc.Version):
		return a, fmt.Errorf("%s: invalid version %q", source, a.doc.Version)
	case a.doc.Engines["platform"] == "" || a.doc.Engines["sdk"] == "":
		return a, fmt.Errorf("%s: engines.platform and engines.sdk are required", source)
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
	idx.Tier = idx.tier()
	return &idx, nil
}

func (p *publisher) readGraftCatalog(ctx context.Context) (*graftCatalog, []byte, error) {
	raw, err := p.bucket.ReadAll(ctx, p.key(graftCatalogKey))
	if errors.Is(err, ErrNotFound) {
		return &graftCatalog{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var cat graftCatalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		return nil, nil, fmt.Errorf("%s is unreadable: %w", graftCatalogKey, err)
	}
	for i := range cat.Grafts {
		cat.Grafts[i].Tier = cat.Grafts[i].tier()
	}
	return &cat, raw, nil
}

func (p *publisher) publishGraft(ctx context.Context, publicBase string, a graftArtifact, meta graftMeta) (graftIndex, error) {
	d := a.doc
	prior, err := p.readGraftIndex(ctx, d.ID)
	if err != nil {
		return graftIndex{}, err
	}
	if prior != nil && prior.tier() != meta.Tier {
		return graftIndex{}, fmt.Errorf("%s is already published as a %s graft: %w", d.ID, prior.tier(), errAlreadyPublished)
	}
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
			return graftIndex{}, fmt.Errorf("%s %s is already published with different content; bump the version: %w", d.ID, d.Version, errAlreadyPublished)
		}
		current.PublishedAt = existing.PublishedAt
		current.Revoked = existing.Revoked
	}
	versions[d.Version] = current
	idx := graftIndex{
		ID:             d.ID,
		Name:           firstNonEmpty(d.Name, d.ID),
		Description:    d.Description,
		Publisher:      firstNonEmpty(meta.Publisher, d.Publisher),
		Homepage:       firstNonEmpty(meta.Homepage, d.Homepage),
		Icon:           iconKey,
		Tier:           meta.Tier,
		Repo:           meta.Repo,
		PublisherKeyID: meta.PublisherKeyID,
	}
	for _, v := range versions {
		idx.Versions = append(idx.Versions, v)
	}
	if err := p.writeGraftIndex(ctx, &idx); err != nil {
		return graftIndex{}, err
	}
	return idx, nil
}

func (p *publisher) writeGraftIndex(ctx context.Context, idx *graftIndex) error {
	sort.Slice(idx.Versions, func(i, j int) bool { return compareSemver(idx.Versions[i].Version, idx.Versions[j].Version) > 0 })
	idx.Latest = idx.Versions[0].Version
	for _, v := range idx.Versions {
		if !v.Revoked {
			idx.Latest = v.Version
			break
		}
	}
	body, _ := json.MarshalIndent(idx, "", "  ")
	_, err := p.putIfChanged(ctx, "grafts/"+idx.ID+"/index.json", body, "application/json; charset=utf-8", cacheIndex, false)
	return err
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
	prior, _, err := p.readGraftCatalog(ctx)
	if err != nil {
		return nil, err
	}
	for _, g := range prior.Grafts {
		byID[g.ID] = g
	}
	revoked = append(revoked, prior.Revoked...)
	for _, a := range artifacts {
		if listed, ok := byID[a.doc.ID]; ok && listed.tier() != tierOfficial {
			return nil, fmt.Errorf("%s is listed in the marketplace as a %s graft; remove that listing before publishing an official graft with the same id", a.doc.ID, listed.tier())
		}
		idx, err := p.publishGraft(ctx, publicBase, a, graftMeta{Tier: tierOfficial})
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

func validateGrafts(w io.Writer, dirs []string, keys []string) error {
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
		if err := verifyFileManifest(a.files); err != nil {
			return fmt.Errorf("%s: %w", a.source, err)
		}
		signed := "unsigned"
		if a.signed {
			signer, err := manifestSigner(a.files, keys)
			if err != nil {
				signed = "signed by a key this check does not know"
			} else {
				signed = "signed by " + signer
			}
		}
		fmt.Fprintf(w, "ok %-24s %-10s %s\n", a.doc.ID, a.doc.Version, signed)
	}
	return nil
}
