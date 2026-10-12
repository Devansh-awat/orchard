package commands

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func TestSatisfiesRange(t *testing.T) {
	cases := []struct {
		version, rng string
		want         bool
	}{
		{"2.70.0", ">=2.67.0 <3", true},
		{"3.0.0", ">=2.67.0 <3", false},
		{"1.4.2", "^1.0.0", true},
		{"2.0.0", "^1.0.0", false},
		{"0.3.9", "^0.3.1", true},
		{"0.4.0", "^0.3.1", false},
		{"1.2.9", "~1.2.0", true},
		{"1.3.0", "~1.2.0", false},
		{"5.1.0", "^4.0.0 || ^5.0.0", true},
		{"1.2.3", "", true},
	}
	for _, c := range cases {
		if got := satisfiesRange(c.version, c.rng); got != c.want {
			t.Errorf("satisfiesRange(%q, %q) = %v, want %v", c.version, c.rng, got, c.want)
		}
	}
}

func TestNewestCompatibleSkipsRevokedAndIncompatible(t *testing.T) {
	g := marketGraft{ID: "x", Versions: []marketVersion{
		{Version: "1.0.0", Digest: "sha256:a", Engines: map[string]string{"platform": ">=2.0.0 <3"}},
		{Version: "1.2.0", Digest: "sha256:b", Engines: map[string]string{"platform": ">=2.0.0 <3"}},
		{Version: "1.3.0", Digest: "sha256:c", Engines: map[string]string{"platform": ">=2.0.0 <3"}},
		{Version: "2.0.0", Digest: "sha256:d", Engines: map[string]string{"platform": ">=3.0.0"}},
	}}
	index := marketIndex{Revoked: []string{"sha256:c"}}
	v, ok := newestCompatible(g, "2.67.3", index)
	if !ok || v.Version != "1.2.0" {
		t.Fatalf("got %v %v, want 1.2.0", v.Version, ok)
	}
}

func makeGraft(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestReadLocalManifestAndChart(t *testing.T) {
	archive := makeGraft(t, map[string]string{
		"graft.json":             `{"id":"notes","name":"Notes","version":"1.2.3","publisher":"me","capabilities":["db"]}`,
		"chart/Chart.yaml":       "name: notes\nversion: 1.0.0\n",
		"server/index.cjs":       "module.exports = {}",
		"chart/templates/a.yaml": "kind: ConfigMap\n",
	})
	m, chart, err := readLocalManifest(archive)
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != "notes" || m.Version != "1.2.3" || len(m.Capabilities) != 1 {
		t.Fatalf("unexpected manifest %+v", m)
	}
	tr := tar.NewReader(bytes.NewReader(chart))
	names := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		names[hdr.Name] = true
	}
	if !names["Chart.yaml"] || !names["templates/a.yaml"] || len(names) != 2 {
		t.Fatalf("chart entries %v", names)
	}
	if _, _, err := readLocalManifest([]byte("not gzip")); err == nil {
		t.Fatal("expected an error for a non-graft file")
	}
}

func TestGraftSpecsRoundTripThroughValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "values.yaml")
	if err := os.WriteFile(path, []byte("signupMode: open\ngrafts:\n  - id: a\n    version: 1.0.0\n    digest: sha256:aa\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := cli.LoadValues(path)
	if err != nil {
		t.Fatal(err)
	}
	specs := readGraftSpecs(values)
	specs, prev := upsertSpec(specs, graftSpec{ID: "a", Version: "1.1.0", Digest: "sha256:bb"})
	if prev == nil || prev.Version != "1.0.0" {
		t.Fatalf("expected previous 1.0.0, got %+v", prev)
	}
	specs, prev = upsertSpec(specs, graftSpec{ID: "b", Version: "0.1.0", Source: "orchard://sha256:cc", Digest: "sha256:cc"})
	if prev != nil {
		t.Fatal("b should be new")
	}
	writeGraftSpecs(values, specs)
	if err := values.Save(); err != nil {
		t.Fatal(err)
	}
	reloaded, _ := cli.LoadValues(path)
	got := readGraftSpecs(reloaded)
	if len(got) != 2 || got[0].Version != "1.1.0" || got[1].Source != "orchard://sha256:cc" {
		t.Fatalf("round trip lost data: %+v", got)
	}
	if reloaded.Get("signupMode") != "open" {
		t.Fatal("unrelated values were lost")
	}
}
