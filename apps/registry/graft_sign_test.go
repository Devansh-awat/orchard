package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func packManifested(t *testing.T, dir string, files map[string]string, tamper string) string {
	t.Helper()
	hashes := map[string]string{}
	for name, body := range files {
		sum := sha256.Sum256([]byte(body))
		hashes[name] = hex.EncodeToString(sum[:])
	}
	manifest, _ := json.Marshal(map[string]any{"files": hashes})
	all := map[string]string{"MANIFEST.json": string(manifest)}
	for name, body := range files {
		all[name] = body
	}
	if tamper != "" {
		all[tamper] = all[tamper] + "tampered"
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range all {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	p := filepath.Join(dir, "notes-1.0.0.graft")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSignGraftsAddsAManifestSignatureServersAccept(t *testing.T) {
	key := newKey(t)
	pub := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	dir := t.TempDir()
	files := map[string]string{
		"graft.json":       `{"id":"notes","version":"1.0.0"}`,
		"server/index.cjs": "module.exports = {}",
	}
	p := packManifested(t, dir, files, "")
	if err := signGrafts([]string{dir}, key, t.Logf); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(p)
	got, err := untarGraft(raw)
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if string(got[name]) != body {
			t.Fatalf("%s changed while signing", name)
		}
	}
	if _, err := manifestSigner(got, []string{pub}); err != nil {
		t.Fatalf("signature does not verify: %v", err)
	}
	if _, err := manifestSigner(got, []string{base64.StdEncoding.EncodeToString(newKey(t).Public().(ed25519.PublicKey))}); err == nil {
		t.Fatal("a signature must not verify under another key")
	}

	if err := signGrafts([]string{dir}, key, t.Logf); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(p)
	again, err := untarGraft(raw)
	if err != nil {
		t.Fatalf("re-signing must replace MANIFEST.sig, not duplicate it: %v", err)
	}
	if _, err := manifestSigner(again, []string{pub}); err != nil {
		t.Fatal(err)
	}
}

func TestSignGraftsRefusesAPackWhoseFilesDoNotMatchTheManifest(t *testing.T) {
	dir := t.TempDir()
	p := packManifested(t, dir, map[string]string{"graft.json": `{}`, "server/index.cjs": "x"}, "server/index.cjs")
	before, _ := os.ReadFile(p)
	err := signGrafts([]string{dir}, newKey(t), t.Logf)
	if err == nil || !strings.Contains(err.Error(), "MANIFEST.json") {
		t.Fatalf("expected a manifest mismatch, got %v", err)
	}
	after, _ := os.ReadFile(p)
	if !bytes.Equal(before, after) {
		t.Fatal("a refused pack must be left untouched")
	}
}
