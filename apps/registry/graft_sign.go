package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func signGraftArchive(raw []byte, key ed25519.PrivateKey) ([]byte, error) {
	files, err := untarGraft(raw)
	if err != nil {
		return nil, err
	}
	if err := verifyFileManifest(files); err != nil {
		return nil, err
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	tw := tar.NewWriter(zw)
	var modTime time.Time
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Name == "MANIFEST.sig" {
			continue
		}
		if hdr.Name == "MANIFEST.json" {
			modTime = hdr.ModTime
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if _, err := io.Copy(tw, tr); err != nil {
			return nil, err
		}
	}
	sig := signDetached(key, files["MANIFEST.json"])
	if err := tw.WriteHeader(&tar.Header{Name: "MANIFEST.sig", Mode: 0o644, Size: int64(len(sig)), ModTime: modTime, Typeflag: tar.TypeReg}); err != nil {
		return nil, err
	}
	if _, err := tw.Write(sig); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func signGrafts(dirs []string, key ed25519.PrivateKey, logf func(string, ...any)) error {
	var paths []string
	for _, dir := range dirs {
		matches, err := filepath.Glob(filepath.Join(dir, "*.graft"))
		if err != nil {
			return err
		}
		paths = append(paths, matches...)
	}
	sort.Strings(paths)
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		signed, err := signGraftArchive(raw, key)
		if err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		if err := os.WriteFile(p, signed, 0o644); err != nil {
			return err
		}
		logf("signed %s", filepath.Base(p))
	}
	return nil
}
