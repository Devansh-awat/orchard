package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func newKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func publicB64(key ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
}

func tarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, name := range names {
		body := files[name]
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func graftFiles(id, version, database string, extra map[string]string) map[string]string {
	if database == "" {
		database = "{}"
	}
	files := map[string]string{
		"graft.json":       `{"id":"` + id + `","name":"Notes","version":"` + version + `","publisher":"acme","description":"Take notes","engines":{"platform":">=2.67.0 <3","sdk":"^1.0.0"},"capabilities":["db"],"database":` + database + `}`,
		"README.md":        "# notes\n",
		"server/index.cjs": "module.exports = {}",
	}
	for name, body := range extra {
		files[name] = body
	}
	return files
}

func sealGraft(t *testing.T, files map[string]string, key ed25519.PrivateKey) []byte {
	t.Helper()
	hashes := map[string]string{}
	for name, body := range files {
		hashes[name] = sha256Hex([]byte(body))
	}
	manifest, _ := json.MarshalIndent(map[string]any{"files": hashes}, "", "  ")
	manifest = append(manifest, '\n')
	sealed := map[string]string{"MANIFEST.json": string(manifest)}
	for name, body := range files {
		sealed[name] = body
	}
	if key != nil {
		sealed["MANIFEST.sig"] = string(signDetached(key, manifest))
	}
	return tarGz(t, sealed)
}

type fakeRelease struct {
	tag        string
	draft      bool
	prerelease bool
	assets     []string
}

type fakeGitHub struct {
	releases map[string][]fakeRelease
	assets   map[string][]byte
	broken   map[string]bool
	tokens   []string
	srv      *httptest.Server
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{releases: map[string][]fakeRelease{}, assets: map[string][]byte{}, broken: map[string]bool{}}
	f.srv = httptest.NewServer(f)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		body, ok := f.assets[strings.TrimPrefix(r.URL.Path, "/assets/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
		return
	}
	repo := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/repos/"), "/releases")
	f.tokens = append(f.tokens, r.Header.Get("Authorization"))
	if f.broken[repo] {
		http.Error(w, "boom", http.StatusInternalServerError)
		return
	}
	out := []githubRelease{}
	for _, rel := range f.releases[repo] {
		gr := githubRelease{TagName: rel.tag, Draft: rel.draft, Prerelease: rel.prerelease, Assets: []githubAsset{}}
		for _, name := range rel.assets {
			gr.Assets = append(gr.Assets, githubAsset{Name: name, Size: int64(len(f.assets[repo+"/"+name])), URL: f.srv.URL + "/assets/" + repo + "/" + name})
		}
		out = append(out, gr)
	}
	json.NewEncoder(w).Encode(out)
}

func (f *fakeGitHub) release(repo, tag string, assets map[string][]byte) {
	rel := fakeRelease{tag: tag}
	names := make([]string, 0, len(assets))
	for name := range assets {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f.assets[repo+"/"+name] = assets[name]
		rel.assets = append(rel.assets, name)
	}
	f.releases[repo] = append([]fakeRelease{rel}, f.releases[repo]...)
}

func writeListing(t *testing.T, dir, id, repo, publisher string, key ed25519.PrivateKey) {
	t.Helper()
	body := `{"id":"` + id + `","repo":"` + repo + `","publisher":"` + publisher + `","publicKey":"` + publicB64(key) + `","homepage":"https://github.com/` + repo + `"}`
	if err := os.WriteFile(filepath.Join(dir, id+".json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readJSON(t *testing.T, fake *fakeS3, key string, into any) []byte {
	t.Helper()
	o, ok := fake.objects[key]
	if !ok {
		t.Fatalf("missing object %s", key)
	}
	if err := json.Unmarshal(o.body, into); err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return o.body
}

func verifyListingSig(t *testing.T, fake *fakeS3, id string, orchard ed25519.PrivateKey) {
	t.Helper()
	body := fake.objects["grafts/"+id+"/listing.json"].body
	sig := fake.objects["grafts/"+id+"/listing.json.sig"].body
	if !strings.HasSuffix(string(sig), "\n") {
		t.Fatal("listing.json.sig must end in a newline")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(orchard.Public().(ed25519.PublicKey), body, raw) {
		t.Fatal("listing.json.sig does not verify with the Orchard public key")
	}
	if ed25519.Verify(newKey(t).Public().(ed25519.PublicKey), body, raw) {
		t.Fatal("listing.json.sig verified with an unrelated key")
	}
}

func newCommunitySync(bucket *Bucket, gh *fakeGitHub, orchard ed25519.PrivateKey) *communitySync {
	return &communitySync{p: newPublisher(bucket), github: &githubClient{base: gh.srv.URL, token: "gh-token"}, key: orchard, publicBase: "https://assets.example/registry"}
}

func TestSyncCommunityPublishesOnlyVerifiedReleases(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	gh := newFakeGitHub(t)
	orchard, author, stranger := newKey(t), newKey(t), newKey(t)
	listings := t.TempDir()
	writeListing(t, listings, "notes", "acme/orchard-notes", "acme", author)
	writeListing(t, listings, "tasks", "acme/orchard-tasks", "acme", author)
	gh.broken["acme/orchard-tasks"] = true

	gh.release("acme/orchard-notes", "v1.0.0", map[string][]byte{"notes-1.0.0.graft": sealGraft(t, graftFiles("notes", "1.0.0", "", nil), author), "notes-1.0.0.tar.gz": []byte("source")})
	gh.release("acme/orchard-notes", "v1.1.0", map[string][]byte{"notes-1.1.0.graft": sealGraft(t, graftFiles("notes", "1.1.0", "", nil), stranger)})
	gh.release("acme/orchard-notes", "v1.2.0", map[string][]byte{"notes-1.2.0.graft": sealGraft(t, graftFiles("notes", "1.2.0", `{"adopts":["users"]}`, nil), author)})
	gh.release("acme/orchard-notes", "v1.3.0", map[string][]byte{"notes-1.3.0.graft": sealGraft(t, graftFiles("notes", "1.3.0", "", map[string]string{"migrations/001_init/migration.sql": "CREATE TABLE IF NOT EXISTS public.notes (id int);"}), author)})
	gh.release("acme/orchard-notes", "v1.4.0", map[string][]byte{"notes-1.4.0.graft": sealGraft(t, graftFiles("notes", "1.5.0", "", nil), author)})
	gh.release("acme/orchard-notes", "v1.6.0", map[string][]byte{"notes-1.6.0.graft": sealGraft(t, graftFiles("notes", "1.6.0", "", nil), nil)})
	tampered := graftFiles("notes", "1.7.0", "", nil)
	sealed := sealGraft(t, tampered, author)
	files, _ := untarGraft(sealed)
	files["server/index.cjs"] = []byte("evil()")
	plain := map[string]string{}
	for k, v := range files {
		plain[k] = string(v)
	}
	gh.release("acme/orchard-notes", "v1.7.0", map[string][]byte{"notes-1.7.0.graft": tarGz(t, plain)})
	impostor := graftFiles("notes", "1.8.0", "", nil)
	impostor["graft.json"] = strings.Replace(impostor["graft.json"], `"publisher":"acme"`, `"publisher":"orchard"`, 1)
	gh.release("acme/orchard-notes", "v1.8.0", map[string][]byte{"notes-1.8.0.graft": sealGraft(t, impostor, author)})
	gh.releases["acme/orchard-notes"] = append([]fakeRelease{{tag: "v9.0.0", draft: true, assets: []string{"notes-9.0.0.graft"}}}, gh.releases["acme/orchard-notes"]...)
	gh.assets["acme/orchard-notes/notes-9.0.0.graft"] = sealGraft(t, graftFiles("notes", "9.0.0", "", nil), author)

	s := newCommunitySync(bucket, gh, orchard)
	var logs bytes.Buffer
	s.p.log = log.New(&logs, "", 0)
	cat, err := s.run(context.Background(), listings, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Grafts) != 1 {
		t.Fatalf("expected only notes in the catalog, got %+v", cat.Grafts)
	}
	for _, reason := range []string{
		"skipped 1.1.0: signature: MANIFEST.sig does not verify",
		"skipped 1.2.0: database.adopts is set",
		"skipped 1.3.0: migrations change the public schema: migrations/001_init/migration.sql",
		"skipped 1.4.0: graft.json says version 1.5.0",
		"skipped 1.6.0: signature: it has no MANIFEST.sig",
		"skipped 1.7.0: files do not match their MANIFEST.json hash: server/index.cjs",
		"skipped 1.8.0: graft.json says publisher \"orchard\", the listing is for \"acme\"",
		"community tasks: skipped, could not read releases",
		"community notes: published 1.0.0 from v1.0.0",
	} {
		if !strings.Contains(logs.String(), reason) {
			t.Errorf("missing log line %q in:\n%s", reason, logs.String())
		}
	}
	if strings.Contains(logs.String(), "9.0.0") {
		t.Errorf("draft releases must be ignored:\n%s", logs.String())
	}
	g := cat.Grafts[0]
	if g.Tier != tierCommunity || g.Repo != "acme/orchard-notes" || g.Publisher != "acme" || g.PublisherKeyID != keyID(author.Public().(ed25519.PublicKey)) {
		t.Fatalf("catalog entry wrong: %+v", g)
	}
	if len(g.Versions) != 1 || g.Versions[0].Version != "1.0.0" || g.Latest != "1.0.0" {
		t.Fatalf("only 1.0.0 should be published, got %+v", g.Versions)
	}
	if g.Versions[0].URL != "https://assets.example/registry/grafts/notes/1.0.0/notes-1.0.0.graft" {
		t.Fatalf("version url %s", g.Versions[0].URL)
	}
	for _, key := range []string{"grafts/notes/1.1.0/notes-1.1.0.graft", "grafts/notes/1.2.0/notes-1.2.0.graft", "grafts/notes/1.3.0/notes-1.3.0.graft", "grafts/notes/1.5.0/notes-1.5.0.graft", "grafts/notes/9.0.0/notes-9.0.0.graft"} {
		if _, ok := fake.objects[key]; ok {
			t.Fatalf("%s should have been skipped", key)
		}
	}

	var listing map[string]any
	body := readJSON(t, fake, "grafts/notes/listing.json", &listing)
	if !bytes.HasPrefix(body, []byte("{\n  \"id\": \"notes\",\n  \"tier\": \"community\",\n  \"publisher\": \"acme\",\n  \"repo\": \"acme/orchard-notes\",\n  \"homepage\": \"https://github.com/acme/orchard-notes\",\n  \"keys\": [\n    \""+publicB64(author)+"\"\n  ],\n  \"listedAt\": \"2026-09-28T12:00:00Z\"\n}\n")) {
		t.Fatalf("listing.json is not in the agreed shape:\n%s", body)
	}
	verifyListingSig(t, fake, "notes", orchard)
	if _, ok := fake.objects["grafts/tasks/listing.json"]; !ok {
		t.Fatal("a listing whose releases cannot be read still gets its listing published")
	}
	var idx graftIndex
	readJSON(t, fake, "grafts/notes/index.json", &idx)
	if idx.Tier != tierCommunity || idx.Repo != "acme/orchard-notes" {
		t.Fatalf("per-graft index lost its tier: %+v", idx)
	}
	for _, tok := range gh.tokens {
		if tok != "Bearer gh-token" {
			t.Fatalf("GitHub API call without the token: %q", tok)
		}
	}

	puts := fake.puts
	s.p.now = func() time.Time { return time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC) }
	if _, err := s.run(context.Background(), listings, ""); err != nil {
		t.Fatal(err)
	}
	if fake.puts != puts {
		t.Fatalf("an unchanged sync rewrote %d objects", fake.puts-puts)
	}
}

func TestSyncCommunityRefusesOfficialIDs(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	gh := newFakeGitHub(t)
	orchard, author := newKey(t), newKey(t)
	official := t.TempDir()
	packGraft(t, official, "notes", "1.0.0", true, "")
	if _, err := newPublisher(bucket).runGrafts(context.Background(), []string{official}, "https://assets.example/registry", ""); err != nil {
		t.Fatal(err)
	}
	listings := t.TempDir()
	writeListing(t, listings, "notes", "mallory/notes", "mallory", author)
	writeListing(t, listings, "tasks", "acme/orchard-tasks", "acme", author)
	gh.release("mallory/notes", "v2.0.0", map[string][]byte{"notes-2.0.0.graft": sealGraft(t, graftFiles("notes", "2.0.0", "", nil), author)})
	gh.release("acme/orchard-tasks", "v0.1.0", map[string][]byte{"tasks-0.1.0.graft": sealGraft(t, graftFiles("tasks", "0.1.0", "", nil), author)})

	cat, err := newCommunitySync(bucket, gh, orchard).run(context.Background(), listings, "")
	if !errors.Is(err, errInvalidListings) {
		t.Fatalf("expected the colliding listing to fail the run, got %v", err)
	}
	if _, ok := fake.objects["grafts/notes/listing.json"]; ok {
		t.Fatal("a listing for an official id must not be published")
	}
	if _, ok := fake.objects["grafts/notes/2.0.0/notes-2.0.0.graft"]; ok {
		t.Fatal("a community release must not land on an official id")
	}
	byID := map[string]graftIndex{}
	for _, g := range cat.Grafts {
		byID[g.ID] = g
	}
	if byID["notes"].Tier != tierOfficial || len(byID["notes"].Versions) != 1 {
		t.Fatalf("official notes was changed: %+v", byID["notes"])
	}
	if byID["tasks"].Tier != tierCommunity || byID["tasks"].Latest != "0.1.0" {
		t.Fatalf("a bad listing stopped a good one: %+v", byID["tasks"])
	}

	again := t.TempDir()
	packGraft(t, again, "tasks", "1.0.0", true, "")
	if _, err := newPublisher(bucket).runGrafts(context.Background(), []string{again}, "https://assets.example/registry", ""); err == nil {
		t.Fatal("publish-grafts must refuse an id that is listed as community")
	}
}

func TestSyncCommunityDelistsRemovedListings(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	gh := newFakeGitHub(t)
	orchard, author := newKey(t), newKey(t)
	listings := t.TempDir()
	writeListing(t, listings, "notes", "acme/orchard-notes", "acme", author)
	writeListing(t, listings, "empty", "acme/orchard-empty", "acme", author)
	gh.release("acme/orchard-notes", "v1.0.0", map[string][]byte{"notes-1.0.0.graft": sealGraft(t, graftFiles("notes", "1.0.0", "", nil), author)})
	gh.release("acme/orchard-notes", "v1.1.0", map[string][]byte{"notes-1.1.0.graft": sealGraft(t, graftFiles("notes", "1.1.0", "", nil), author)})
	s := newCommunitySync(bucket, gh, orchard)
	if _, err := s.run(context.Background(), listings, ""); err != nil {
		t.Fatal(err)
	}

	os.Remove(filepath.Join(listings, "notes.json"))
	os.Remove(filepath.Join(listings, "empty.json"))
	cat, err := s.run(context.Background(), listings, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Grafts) != 0 {
		t.Fatalf("delisted grafts must leave the catalog: %+v", cat.Grafts)
	}
	for _, id := range []string{"notes", "empty"} {
		var listing publishedListing
		readJSON(t, fake, "grafts/"+id+"/listing.json", &listing)
		if listing.Tier != tierDelisted || listing.Repo != "acme/orchard-"+id || len(listing.Keys) != 1 {
			t.Fatalf("%s listing not delisted: %+v", id, listing)
		}
		verifyListingSig(t, fake, id, orchard)
	}
	var idx graftIndex
	readJSON(t, fake, "grafts/notes/index.json", &idx)
	if len(idx.Versions) != 2 {
		t.Fatalf("delisting must keep published versions: %+v", idx.Versions)
	}
	for _, v := range idx.Versions {
		if !v.Revoked {
			t.Fatalf("version %s should be revoked", v.Version)
		}
	}
	if _, ok := fake.objects["grafts/notes/1.0.0/notes-1.0.0.graft"]; !ok {
		t.Fatal("delisting must not delete artifacts")
	}
	puts := fake.puts
	if _, err := s.run(context.Background(), listings, ""); err != nil {
		t.Fatal(err)
	}
	if fake.puts != puts {
		t.Fatal("delisting twice rewrote objects")
	}
}

func TestSyncCommunityKeepsGoingPastInvalidFiles(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	gh := newFakeGitHub(t)
	orchard, author := newKey(t), newKey(t)
	listings := t.TempDir()
	writeListing(t, listings, "notes", "acme/orchard-notes", "acme", author)
	gh.release("acme/orchard-notes", "v1.0.0", map[string][]byte{"notes-1.0.0.graft": sealGraft(t, graftFiles("notes", "1.0.0", "", nil), author)})
	s := newCommunitySync(bucket, gh, orchard)
	if _, err := s.run(context.Background(), listings, ""); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(listings, "notes.json"), []byte(`{"id":"notes","repo":"acme/orchard-notes"`), 0o644)
	writeListing(t, listings, "tasks", "acme/orchard-tasks", "acme", author)
	cat, err := s.run(context.Background(), listings, "")
	if !errors.Is(err, errInvalidListings) {
		t.Fatalf("an invalid listing file must fail the run, got %v", err)
	}
	var listing publishedListing
	readJSON(t, fake, "grafts/notes/listing.json", &listing)
	if listing.Tier != tierCommunity || len(cat.Grafts) != 1 {
		t.Fatalf("a broken edit must not delist the graft: %+v %+v", listing, cat.Grafts)
	}
	if _, ok := fake.objects["grafts/tasks/listing.json"]; !ok {
		t.Fatal("the valid listing was not processed")
	}
}

func TestValidateCommunityCatchesMalformedFiles(t *testing.T) {
	author := newKey(t)
	dir := t.TempDir()
	writeListing(t, dir, "notes", "acme/orchard-notes", "acme", author)
	var out bytes.Buffer
	if err := validateCommunity(&out, dir, ""); err != nil {
		t.Fatalf("a good listing failed: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), keyID(author.Public().(ed25519.PublicKey))) {
		t.Fatalf("validate-community should print the keyId: %s", out.String())
	}
	cases := map[string]string{
		"extra.json":     `{"id":"extra","repo":"acme/x","publisher":"acme","publicKey":"` + publicB64(author) + `","stars":5}`,
		"badkey.json":    `{"id":"badkey","repo":"acme/x","publisher":"acme","publicKey":"bm9wZQ=="}`,
		"wrongname.json": `{"id":"other","repo":"acme/x","publisher":"acme","publicKey":"` + publicB64(author) + `"}`,
		"badrepo.json":   `{"id":"badrepo","repo":"https://github.com/acme/x","publisher":"acme","publicKey":"` + publicB64(author) + `"}`,
		"badpub.json":    `{"id":"badpub","repo":"acme/x","publisher":"Acme Corp","publicKey":"` + publicB64(author) + `"}`,
		"insecure.json":  `{"id":"insecure","repo":"acme/x","publisher":"acme","publicKey":"` + publicB64(author) + `","homepage":"http://acme.dev"}`,
		"broken.json":    `{"id":`,
		"notes.yaml":     "id: notes\n",
	}
	for name, body := range cases {
		bad := t.TempDir()
		writeListing(t, bad, "notes", "acme/orchard-notes", "acme", author)
		os.WriteFile(filepath.Join(bad, name), []byte(body), 0o644)
		out.Reset()
		if err := validateCommunity(&out, bad, ""); err == nil {
			t.Errorf("%s should be rejected", name)
		} else if !strings.Contains(out.String(), name) {
			t.Errorf("%s: the report should name the file: %s", name, out.String())
		}
	}
	grafts := t.TempDir()
	os.MkdirAll(filepath.Join(grafts, "notes"), 0o755)
	os.WriteFile(filepath.Join(grafts, "notes", "graft.json"), []byte(`{"id":"notes"}`), 0o644)
	if err := validateCommunity(&out, dir, grafts); err == nil {
		t.Fatal("a listing that reuses an official id should be rejected")
	}
}

func TestVerifyGraftArchive(t *testing.T) {
	key := newKey(t)
	good := sealGraft(t, graftFiles("notes", "1.0.0", "", nil), key)
	a, err := parseGraftArtifact(good, "good")
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyFileManifest(a.files); err != nil {
		t.Fatal(err)
	}
	signer, err := manifestSigner(a.files, []string{publicB64(newKey(t)), publicB64(key)})
	if err != nil || signer != keyID(key.Public().(ed25519.PublicKey)) || len(signer) != 16 {
		t.Fatalf("signer %q %v", signer, err)
	}

	files, _ := untarGraft(good)
	plain := map[string]string{}
	for k, v := range files {
		plain[k] = string(v)
	}
	withExtra := map[string]string{"server/extra.cjs": "x"}
	without := map[string]string{}
	for k, v := range plain {
		withExtra[k] = v
		if k != "README.md" {
			without[k] = v
		}
	}
	reserved := map[string]string{".origin.json": `{"source":"marketplace"}`}
	for k, v := range plain {
		reserved[k] = v
	}
	for name, archive := range map[string]map[string]string{"extra file": withExtra, "missing file": without, "origin file": reserved} {
		b, err := parseGraftArtifact(tarGz(t, archive), name)
		if err != nil {
			t.Fatal(err)
		}
		if verifyFileManifest(b.files) == nil {
			t.Errorf("%s should fail the manifest check", name)
		}
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "graft.json", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"})
	tw.Close()
	gz.Close()
	if _, err := untarGraft(buf.Bytes()); err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("symlinks must be refused, got %v", err)
	}
	if _, err := untarGraft(tarGz(t, map[string]string{"../escape": "x"})); err == nil {
		t.Fatal("paths outside the graft must be refused")
	}

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "notes-1.0.0.graft"), good, 0o644)
	var out bytes.Buffer
	if err := validateGrafts(&out, []string{dir}, []string{publicB64(key)}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "signed by "+keyID(key.Public().(ed25519.PublicKey))) {
		t.Fatalf("validate-grafts should report the signer: %s", out.String())
	}
	out.Reset()
	validateGrafts(&out, []string{dir}, officialGraftKeys)
	if !strings.Contains(out.String(), "does not know") {
		t.Fatalf("an unknown signer should be reported as such: %s", out.String())
	}
	os.WriteFile(filepath.Join(dir, "notes-1.0.0.graft"), tarGz(t, withExtra), 0o644)
	if err := validateGrafts(&out, []string{dir}, nil); err == nil {
		t.Fatal("validate-grafts must fail on a file outside MANIFEST.json")
	}
}

func TestParseSigningKeyAcceptsWhatGraftKeygenWrites(t *testing.T) {
	key := newKey(t)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	for name, value := range map[string]string{"base64": base64.StdEncoding.EncodeToString(pemBytes), "pem": string(pemBytes)} {
		parsed, err := parseSigningKey(value)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !parsed.Equal(key) {
			t.Fatalf("%s: parsed a different key", name)
		}
	}
	if _, err := parseSigningKey("bm9wZQ=="); err == nil {
		t.Fatal("garbage should be refused")
	}
}
