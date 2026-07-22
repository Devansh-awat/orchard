package buildctx

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestPackHonorsIgnores(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	os.MkdirAll(filepath.Join(dir, "node_modules/x"), 0o755)
	os.MkdirAll(filepath.Join(dir, ".git"), 0o755)
	os.MkdirAll(filepath.Join(dir, ".orchard"), 0o755)
	os.WriteFile(filepath.Join(dir, ".dockerignore"), []byte("node_modules\ndist\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "src/index.js"), []byte("console.log(1)"), 0o644)
	os.WriteFile(filepath.Join(dir, "node_modules/x/big.js"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, ".git/config"), []byte("secret"), 0o644)
	os.WriteFile(filepath.Join(dir, ".orchard/project.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(dir, ".env.orchard"), []byte("KEY=1"), 0o644)
	os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0o644)

	data, files, err := Pack(dir)
	if err != nil {
		t.Fatal(err)
	}
	if files != 3 {
		t.Errorf("expected 3 files, got %d", files)
	}
	gz, _ := gzip.NewReader(bytes.NewReader(data))
	tr := tar.NewReader(gz)
	names := map[string]bool{}
	for {
		h, rerr := tr.Next()
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			t.Fatal(rerr)
		}
		names[h.Name] = true
	}
	for _, banned := range []string{".git/config", ".orchard/project.json", "node_modules/x/big.js", ".env.orchard"} {
		if names[banned] {
			t.Errorf("banned file %s in archive", banned)
		}
	}
	for _, want := range []string{"src/index.js", "package.json", ".dockerignore"} {
		if !names[want] {
			t.Errorf("missing %s from archive", want)
		}
	}
}
