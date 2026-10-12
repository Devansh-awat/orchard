package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func packGraft(t *testing.T, dir, id, version string, signed bool, extra string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	files := map[string]string{
		"graft.json":       `{"id":"` + id + `","name":"Notes","version":"` + version + `","publisher":"me","description":"Take notes` + extra + `","engines":{"platform":">=2.67.0 <3","sdk":"^1.0.0"},"capabilities":["db"]}`,
		"README.md":        "# notes\n",
		"server/index.cjs": "module.exports = {}" + extra,
	}
	if signed {
		files["MANIFEST.sig"] = "c2ln"
	}
	for name, body := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	path := filepath.Join(dir, id+"-"+version+".graft")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPublishGraftsBuildsMarketplaceAndRefusesMutation(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	dir := t.TempDir()
	packGraft(t, dir, "notes", "1.0.0", true, "")
	packGraft(t, dir, "notes", "1.1.0", true, "")
	revoked := filepath.Join(t.TempDir(), "revoked.txt")
	os.WriteFile(revoked, []byte("# bad build\nABCDEF\n"), 0o644)

	p := newPublisher(bucket)
	cat, err := p.runGrafts(context.Background(), []string{dir}, "https://assets.example/registry", revoked)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Grafts) != 1 || cat.Grafts[0].Latest != "1.1.0" || len(cat.Grafts[0].Versions) != 2 {
		t.Fatalf("unexpected catalogue %+v", cat.Grafts)
	}
	if cat.Revoked[0] != "sha256:abcdef" {
		t.Fatalf("revocations not normalised: %v", cat.Revoked)
	}
	v := cat.Grafts[0].Versions[0]
	if v.URL != "https://assets.example/registry/grafts/notes/1.1.0/notes-1.1.0.graft" || !v.Signed || !strings.HasPrefix(v.Digest, "sha256:") {
		t.Fatalf("version entry wrong: %+v", v)
	}
	for _, key := range []string{"grafts/index.json", "grafts/notes/index.json", "grafts/notes/1.0.0/notes-1.0.0.graft", "grafts/notes/1.1.0/graft.json", "grafts/notes/1.1.0/README.md"} {
		if _, ok := fake.objects["bucket/"+key]; !ok {
			if _, ok := fake.objects[key]; !ok {
				t.Fatalf("missing object %s", key)
			}
		}
	}

	again := t.TempDir()
	packGraft(t, again, "notes", "1.1.0", true, " changed")
	if _, err := p.runGrafts(context.Background(), []string{again}, "https://assets.example/registry", ""); err == nil {
		t.Fatal("republishing a version with different content must fail")
	}

	other := t.TempDir()
	packGraft(t, other, "tasks", "0.1.0", true, "")
	cat, err = p.runGrafts(context.Background(), []string{other}, "https://assets.example/registry", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Grafts) != 2 || len(cat.Revoked) != 1 {
		t.Fatalf("catalogue should keep earlier grafts and revocations: %+v", cat)
	}
	body, _ := json.Marshal(cat)
	if !strings.Contains(string(body), `"id":"notes"`) || !strings.Contains(string(body), `"id":"tasks"`) {
		t.Fatal("catalogue lost a graft")
	}
}

func TestReadGraftArtifactRejectsBadManifests(t *testing.T) {
	dir := t.TempDir()
	path := packGraft(t, dir, "Bad_ID", "1.0.0", false, "")
	if _, err := readGraftArtifact(path); err == nil {
		t.Fatal("expected invalid id to be rejected")
	}
	os.WriteFile(filepath.Join(dir, "junk.graft"), []byte("nope"), 0o644)
	if _, err := readGraftArtifact(filepath.Join(dir, "junk.graft")); err == nil {
		t.Fatal("expected non-gzip to be rejected")
	}
}
