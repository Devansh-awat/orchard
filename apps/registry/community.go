package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	communityReleaseLimit = 20
	listingContentType    = "application/json; charset=utf-8"
	listingSigContentType = "text/plain; charset=utf-8"
)

var (
	publisherRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}$`)
	repoRe      = regexp.MustCompile(`^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/([A-Za-z0-9._-]{1,100})$`)
)

var errInvalidListings = errors.New("some community listings are invalid")

type communityListing struct {
	ID        string `json:"id"`
	Repo      string `json:"repo"`
	Publisher string `json:"publisher"`
	PublicKey string `json:"publicKey"`
	Homepage  string `json:"homepage,omitempty"`
	file      string
}

type publishedListing struct {
	ID        string   `json:"id"`
	Tier      string   `json:"tier"`
	Publisher string   `json:"publisher"`
	Repo      string   `json:"repo"`
	Homepage  string   `json:"homepage,omitempty"`
	Keys      []string `json:"keys"`
	ListedAt  string   `json:"listedAt"`
}

func (l communityListing) validate() error {
	if !graftIDRe.MatchString(l.ID) {
		return fmt.Errorf("id %q must be 2 to 48 lowercase letters, digits and hyphens, starting with a letter", l.ID)
	}
	m := repoRe.FindStringSubmatch(l.Repo)
	if m == nil || m[2] == "." || m[2] == ".." {
		return fmt.Errorf("repo %q must be owner/name on GitHub", l.Repo)
	}
	if !publisherRe.MatchString(l.Publisher) {
		return fmt.Errorf("publisher %q must be 1 to 39 lowercase letters, digits and hyphens", l.Publisher)
	}
	if _, err := parsePublicKey(l.PublicKey); err != nil {
		return fmt.Errorf("publicKey: %w", err)
	}
	if l.Homepage != "" {
		u, err := url.Parse(l.Homepage)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return fmt.Errorf("homepage %q must be an https url", l.Homepage)
		}
	}
	return nil
}

func (l communityListing) keyID() string {
	pub, _ := parsePublicKey(l.PublicKey)
	return keyID(pub)
}

func loadListings(dir string) ([]communityListing, map[string]bool, []error, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, nil, err
	}
	present := map[string]bool{}
	var listings []communityListing
	var problems []error
	for _, entry := range entries {
		name := entry.Name()
		file := filepath.Join(dir, name)
		if strings.HasPrefix(name, ".") || name == "README.md" {
			continue
		}
		if entry.IsDir() || filepath.Ext(name) != ".json" {
			problems = append(problems, fmt.Errorf("%s: only <id>.json listing files belong in %s", file, dir))
			continue
		}
		stem := strings.TrimSuffix(name, ".json")
		present[stem] = true
		raw, err := os.ReadFile(file)
		if err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", file, err))
			continue
		}
		var l communityListing
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&l); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", file, err))
			continue
		}
		if dec.More() {
			problems = append(problems, fmt.Errorf("%s: has more than one JSON value", file))
			continue
		}
		l.file = file
		if err := l.validate(); err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", file, err))
			continue
		}
		if stem != l.ID {
			problems = append(problems, fmt.Errorf("%s: must be named %s.json to match its id", file, l.ID))
			continue
		}
		listings = append(listings, l)
	}
	sort.Slice(listings, func(i, j int) bool { return listings[i].ID < listings[j].ID })
	return listings, present, problems, nil
}

func officialIDs(dir string) (map[string]bool, error) {
	ids := map[string]bool{}
	if dir == "" {
		return ids, nil
	}
	matches, err := filepath.Glob(filepath.Join(dir, "*", "graft.json"))
	if err != nil {
		return nil, err
	}
	for _, m := range matches {
		raw, err := os.ReadFile(m)
		if err != nil {
			return nil, err
		}
		var doc struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("%s: %w", m, err)
		}
		if doc.ID != "" {
			ids[doc.ID] = true
		}
	}
	return ids, nil
}

func validateCommunity(w io.Writer, dir, officialDir string) error {
	listings, _, problems, err := loadListings(dir)
	if err != nil {
		return err
	}
	official, err := officialIDs(officialDir)
	if err != nil {
		return err
	}
	for _, l := range listings {
		if official[l.ID] {
			problems = append(problems, fmt.Errorf("%s: %s is the id of an official graft", l.file, l.ID))
			continue
		}
		fmt.Fprintf(w, "ok %-24s %-40s key %s\n", l.ID, l.Repo, l.keyID())
	}
	for _, p := range problems {
		fmt.Fprintf(w, "invalid %v\n", p)
	}
	if len(problems) > 0 {
		return fmt.Errorf("%d of %d listing files are invalid", len(problems), len(problems)+len(listings))
	}
	return nil
}

type githubClient struct {
	base   string
	token  string
	client *http.Client
}

type githubAsset struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"browser_download_url"`
}

type githubRelease struct {
	TagName    string        `json:"tag_name"`
	Draft      bool          `json:"draft"`
	Prerelease bool          `json:"prerelease"`
	Assets     []githubAsset `json:"assets"`
}

func (g *githubClient) httpClient() *http.Client {
	if g.client != nil {
		return g.client
	}
	return &http.Client{Timeout: 2 * time.Minute}
}

func (g *githubClient) releases(ctx context.Context, repo string) ([]githubRelease, error) {
	target := strings.TrimSuffix(g.base, "/") + "/repos/" + repo + "/releases?per_page=50"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	resp, err := g.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("listing releases of %s: %s", repo, resp.Status)
	}
	var all []githubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&all); err != nil {
		return nil, fmt.Errorf("listing releases of %s: %w", repo, err)
	}
	var out []githubRelease
	for _, r := range all {
		if r.Draft || r.Prerelease {
			continue
		}
		out = append(out, r)
		if len(out) == communityReleaseLimit {
			break
		}
	}
	return out, nil
}

func (g *githubClient) download(ctx context.Context, target string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := g.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGraftSize+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxGraftSize {
		return nil, errors.New("asset is larger than 64 MiB")
	}
	return body, nil
}

func assetVersion(id, name string) (string, bool) {
	if !strings.HasPrefix(name, id+"-") || !strings.HasSuffix(name, ".graft") {
		return "", false
	}
	version := strings.TrimSuffix(strings.TrimPrefix(name, id+"-"), ".graft")
	return version, semverRe.MatchString(version)
}

type communitySync struct {
	p          *publisher
	github     *githubClient
	key        ed25519.PrivateKey
	publicBase string
}

func listingKey(id string) string { return "grafts/" + id + "/listing.json" }

func (s *communitySync) readListing(ctx context.Context, id string) (*publishedListing, error) {
	raw, err := s.p.bucket.ReadAll(ctx, s.p.key(listingKey(id)))
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var l publishedListing
	if err := json.Unmarshal(raw, &l); err != nil {
		s.p.log.Printf("community %s: the published listing is unreadable and will be replaced: %v", id, err)
		return nil, nil
	}
	return &l, nil
}

func (s *communitySync) writeListing(ctx context.Context, l publishedListing) (bool, error) {
	body, _ := json.MarshalIndent(l, "", "  ")
	body = append(body, '\n')
	changed, err := s.p.putIfChanged(ctx, listingKey(l.ID), body, listingContentType, cacheIndex, false)
	if err != nil {
		return false, err
	}
	sigChanged, err := s.p.putIfChanged(ctx, listingKey(l.ID)+".sig", signDetached(s.key, body), listingSigContentType, cacheIndex, false)
	return changed || sigChanged, err
}

func (s *communitySync) publishListing(ctx context.Context, l communityListing) error {
	prior, err := s.readListing(ctx, l.ID)
	if err != nil {
		return err
	}
	listedAt := s.p.now().UTC().Format(time.RFC3339)
	if prior != nil && prior.Tier == tierCommunity && prior.ListedAt != "" {
		listedAt = prior.ListedAt
	}
	changed, err := s.writeListing(ctx, publishedListing{
		ID:        l.ID,
		Tier:      tierCommunity,
		Publisher: l.Publisher,
		Repo:      l.Repo,
		Homepage:  l.Homepage,
		Keys:      []string{strings.TrimSpace(l.PublicKey)},
		ListedAt:  listedAt,
	})
	if changed {
		s.p.log.Printf("community %s: listing published for %s", l.ID, l.Repo)
	}
	return err
}

func (s *communitySync) syncReleases(ctx context.Context, l communityListing, idx *graftIndex) (*graftIndex, error) {
	releases, err := s.github.releases(ctx, l.Repo)
	if err != nil {
		s.p.log.Printf("community %s: skipped, could not read releases: %v", l.ID, err)
		return idx, nil
	}
	known := map[string]bool{}
	if idx != nil {
		for _, v := range idx.Versions {
			known[v.Version] = true
		}
	}
	meta := graftMeta{Tier: tierCommunity, Repo: l.Repo, PublisherKeyID: l.keyID(), Publisher: l.Publisher, Homepage: l.Homepage}
	for _, r := range releases {
		for _, asset := range r.Assets {
			version, ok := assetVersion(l.ID, asset.Name)
			if !ok || known[version] {
				continue
			}
			known[version] = true
			if asset.Size > maxGraftSize {
				s.p.log.Printf("community %s: skipped %s, the asset is larger than 64 MiB", l.ID, version)
				continue
			}
			raw, err := s.github.download(ctx, asset.URL)
			if err != nil {
				s.p.log.Printf("community %s: skipped %s: %v", l.ID, version, err)
				continue
			}
			a, err := parseGraftArtifact(raw, asset.Name)
			if err != nil {
				s.p.log.Printf("community %s: skipped %s: %v", l.ID, version, err)
				continue
			}
			signer, err := checkCommunityGraft(a, l, version)
			if err != nil {
				s.p.log.Printf("community %s: skipped %s: %v", l.ID, version, err)
				continue
			}
			meta.PublisherKeyID = signer
			published, err := s.p.publishGraft(ctx, s.publicBase, a, meta)
			if errors.Is(err, errAlreadyPublished) {
				s.p.log.Printf("community %s: skipped %s: %v", l.ID, version, err)
				continue
			}
			if err != nil {
				return idx, err
			}
			idx = &published
			s.p.log.Printf("community %s: published %s from %s", l.ID, version, r.TagName)
		}
	}
	if idx != nil && (idx.Repo != l.Repo || idx.Publisher != l.Publisher || idx.PublisherKeyID != l.keyID()) {
		idx.Repo, idx.Publisher, idx.PublisherKeyID = l.Repo, l.Publisher, l.keyID()
		if l.Homepage != "" {
			idx.Homepage = l.Homepage
		}
		if err := s.p.writeGraftIndex(ctx, idx); err != nil {
			return idx, err
		}
	}
	return idx, nil
}

func (s *communitySync) delist(ctx context.Context, id string) error {
	prior, err := s.readListing(ctx, id)
	if err != nil {
		return err
	}
	if prior != nil && prior.Tier == tierCommunity {
		prior.Tier = tierDelisted
		if _, err := s.writeListing(ctx, *prior); err != nil {
			return err
		}
		s.p.log.Printf("community %s: delisted", id)
	}
	idx, err := s.p.readGraftIndex(ctx, id)
	if err != nil || idx == nil || idx.tier() != tierCommunity {
		return err
	}
	changed := false
	for i := range idx.Versions {
		if !idx.Versions[i].Revoked {
			idx.Versions[i].Revoked = true
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.p.writeGraftIndex(ctx, idx)
}

func (s *communitySync) publishedListingIDs(ctx context.Context) ([]string, error) {
	objects, err := s.p.bucket.List(ctx, s.p.key("grafts/"))
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, o := range objects {
		parts := strings.Split(strings.TrimPrefix(o.Key, s.p.prefix), "/")
		if len(parts) == 3 && parts[0] == "grafts" && parts[2] == "listing.json" {
			ids = append(ids, parts[1])
		}
	}
	return ids, nil
}

func (s *communitySync) run(ctx context.Context, dir, revokedFile string) (*graftCatalog, error) {
	listings, present, problems, err := loadListings(dir)
	if err != nil {
		return nil, err
	}
	for _, problem := range problems {
		s.p.log.Printf("invalid listing %v", problem)
	}
	invalid := len(problems)
	revoked, err := loadRevoked(revokedFile)
	if err != nil {
		return nil, err
	}
	prior, priorRaw, err := s.p.readGraftCatalog(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]graftIndex{}
	for _, g := range prior.Grafts {
		byID[g.ID] = g
	}
	for _, l := range listings {
		if g, ok := byID[l.ID]; ok && g.tier() != tierCommunity {
			s.p.log.Printf("invalid listing %s: %s is already published as a %s graft", l.file, l.ID, g.tier())
			invalid++
			continue
		}
		idx, err := s.p.readGraftIndex(ctx, l.ID)
		if err != nil {
			return nil, err
		}
		if idx != nil && idx.tier() != tierCommunity {
			s.p.log.Printf("invalid listing %s: %s is already published as a %s graft", l.file, l.ID, idx.tier())
			invalid++
			continue
		}
		if err := s.publishListing(ctx, l); err != nil {
			return nil, err
		}
		idx, err = s.syncReleases(ctx, l, idx)
		if err != nil {
			return nil, err
		}
		if idx != nil {
			byID[l.ID] = *idx
		}
	}
	gone := map[string]bool{}
	published, err := s.publishedListingIDs(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range published {
		gone[id] = true
	}
	for id, g := range byID {
		if g.tier() == tierCommunity {
			gone[id] = true
		}
	}
	var delisted []string
	for id := range gone {
		if !present[id] {
			delisted = append(delisted, id)
		}
	}
	sort.Strings(delisted)
	for _, id := range delisted {
		if err := s.delist(ctx, id); err != nil {
			return nil, err
		}
		if g, ok := byID[id]; ok && g.tier() == tierCommunity {
			delete(byID, id)
		}
	}
	cat := &graftCatalog{GeneratedAt: prior.GeneratedAt, Sequence: prior.Sequence, ExpiresAt: prior.ExpiresAt, Grafts: []graftIndex{}, Revoked: dedupe(append(revoked, prior.Revoked...))}
	for _, g := range byID {
		cat.Grafts = append(cat.Grafts, g)
	}
	sort.Slice(cat.Grafts, func(i, j int) bool { return cat.Grafts[i].ID < cat.Grafts[j].ID })
	body, _ := json.MarshalIndent(cat, "", "  ")
	if changed := !bytes.Equal(body, priorRaw); changed || s.p.signKey != nil {
		if changed {
			cat.GeneratedAt = s.p.now().UTC().Format(time.RFC3339)
		}
		cat.Sequence, cat.ExpiresAt = s.p.stamp()
		body, _ = json.MarshalIndent(cat, "", "  ")
		if _, err := s.p.putIndex(ctx, graftCatalogKey, body); err != nil {
			return nil, err
		}
	}
	if invalid > 0 {
		return cat, fmt.Errorf("%d listing files: %w", invalid, errInvalidListings)
	}
	return cat, nil
}
