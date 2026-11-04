// signhostbin writes the release manifest for the host commands and signs it.
// It runs inside the server image build, in the one step that sees the key.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/release"
)

var signed = []string{"orchardctl-linux-amd64", "orchardctl-linux-arm64", "orchard-sync-commands"}

func parseKey(raw []byte) (ed25519.PrivateKey, error) {
	text := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(text, "-----BEGIN") {
		decoded, err := base64.StdEncoding.DecodeString(text)
		if err != nil {
			return nil, errors.New("the signing key is neither a PEM nor base64 of one")
		}
		text = string(decoded)
	}
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		return nil, errors.New("the signing key has no PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("the signing key is not a PKCS8 private key")
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("the signing key is not ed25519")
	}
	return key, nil
}

func run(dir, version, keyFile string, require bool) error {
	files := map[string][]byte{}
	for _, name := range signed {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		files[name] = data
	}
	manifest := release.BuildManifest(version, files)
	if err := os.WriteFile(filepath.Join(dir, release.ManifestFile), manifest, 0o644); err != nil {
		return err
	}

	raw, err := os.ReadFile(keyFile)
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		if require && len(release.PublicKeys) > 0 {
			return errors.New("this release build has no signing key, so hosts would refuse its commands")
		}
		fmt.Println("no signing key: host commands in this image are unsigned")
		return nil
	}
	key, err := parseKey(raw)
	if err != nil {
		return err
	}
	public, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return err
	}
	encoded := base64.StdEncoding.EncodeToString(public)
	if len(release.PublicKeys) > 0 && !slices.Contains(release.PublicKeys, encoded) {
		return errors.New("the signing key is not one of the keys orchardctl trusts")
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest))
	if err := os.WriteFile(filepath.Join(dir, release.SignatureFile), []byte(signature), 0o644); err != nil {
		return err
	}
	fmt.Println("signed host commands for version " + version)
	return nil
}

func main() {
	dir := flag.String("dir", "", "directory holding the host commands")
	version := flag.String("version", "", "release version")
	keyFile := flag.String("key", "", "file holding the signing key")
	require := flag.Bool("require", false, "fail when a release has no key")
	flag.Parse()
	if err := run(*dir, *version, *keyFile, *require); err != nil {
		fmt.Fprintln(os.Stderr, "signhostbin: "+err.Error())
		os.Exit(1)
	}
}
