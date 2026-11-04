package buildctx

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func packedNames(t *testing.T, files map[string]string) []string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, _, err := Pack(dir)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			names = append(names, hdr.Name)
		}
	}
	sort.Strings(names)
	return names
}

func contains(names []string, want string) bool {
	for _, name := range names {
		if name == want {
			return true
		}
	}
	return false
}

func TestSecretsStayOutEvenWithADockerignore(t *testing.T) {
	names := packedNames(t, map[string]string{
		".dockerignore":      "node_modules\n",
		".gitignore":         ".env\n",
		"Dockerfile":         "FROM scratch\n",
		".env":               "SECRET=1\n",
		".env.production":    "SECRET=1\n",
		"api/.env.local":     "SECRET=1\n",
		".npmrc":             "//registry/:_authToken=x\n",
		".aws/credentials":   "x\n",
		"certs/server.pem":   "x\n",
		"deploy/id_rsa":      "x\n",
		".env.example":       "SECRET=\n",
		"src/environment.ts": "x\n",
	})
	for _, secret := range []string{".env", ".env.production", "api/.env.local", ".npmrc", ".aws/credentials", "certs/server.pem", "deploy/id_rsa"} {
		if contains(names, secret) {
			t.Errorf("%s was uploaded", secret)
		}
	}
	for _, keep := range []string{"Dockerfile", ".env.example", "src/environment.ts"} {
		if !contains(names, keep) {
			t.Errorf("%s was left out", keep)
		}
	}
}

func TestSecretsStayOutWithNoIgnoreFiles(t *testing.T) {
	names := packedNames(t, map[string]string{"app.js": "x\n", ".env": "SECRET=1\n"})
	if contains(names, ".env") || !contains(names, "app.js") {
		t.Fatalf("got %v", names)
	}
}

func TestDockerignoreCanOptASecretBackIn(t *testing.T) {
	names := packedNames(t, map[string]string{
		".dockerignore": "!.env.build\n",
		".env.build":    "PUBLIC=1\n",
		".env":          "SECRET=1\n",
	})
	if !contains(names, ".env.build") {
		t.Fatalf(".env.build should upload after opting in: %v", names)
	}
	if contains(names, ".env") {
		t.Fatalf(".env must still stay out: %v", names)
	}
}
