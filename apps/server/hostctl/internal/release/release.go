// Package release checks that host commands copied out of the server image are
// the ones an Orchard release signed. The running pod is not trusted: it could
// be compromised, and orchardctl runs as root on the host.
package release

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	ManifestFile  = "hostbin.manifest"
	SignatureFile = "hostbin.sig"
	manifestMagic = "orchard-hostbin-v1"
)

// Version is set at build time. Empty on a local build.
var Version = ""

// Manifest lists the files one release signed.
type Manifest struct {
	Version string
	Files   map[string]string
}

// BuildManifest has no trailing newline, so the signed bytes survive being read
// back through a shell's command substitution.
func BuildManifest(version string, files map[string][]byte) []byte {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	lines := []string{manifestMagic, "version " + version}
	for _, name := range names {
		sum := sha256.Sum256(files[name])
		lines = append(lines, "sha256 "+hex.EncodeToString(sum[:])+" "+name)
	}
	return []byte(strings.Join(lines, "\n"))
}

func ParseManifest(raw []byte) (Manifest, error) {
	lines := strings.Split(string(raw), "\n")
	if len(lines) < 3 || lines[0] != manifestMagic {
		return Manifest{}, errors.New("not a release manifest")
	}
	version, ok := strings.CutPrefix(lines[1], "version ")
	if !ok {
		return Manifest{}, errors.New("release manifest has no version")
	}
	m := Manifest{Version: version, Files: map[string]string{}}
	for _, line := range lines[2:] {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[0] != "sha256" {
			return Manifest{}, fmt.Errorf("unexpected line in release manifest: %q", line)
		}
		m.Files[fields[2]] = fields[1]
	}
	return m, nil
}

func parsePublicKey(encoded string) (ed25519.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not an ed25519 public key")
	}
	return key, nil
}

// Verify checks the signature, then that data is the named file in the manifest.
func Verify(keys []string, manifest []byte, signature string, name string, data []byte) (Manifest, error) {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return Manifest{}, errors.New("release signature is missing or malformed")
	}
	trusted := false
	for _, encoded := range keys {
		key, err := parsePublicKey(encoded)
		if err == nil && ed25519.Verify(key, manifest, sig) {
			trusted = true
			break
		}
	}
	if !trusted {
		return Manifest{}, errors.New("release signature does not match a trusted key")
	}
	m, err := ParseManifest(manifest)
	if err != nil {
		return Manifest{}, err
	}
	want, ok := m.Files[name]
	if !ok {
		return Manifest{}, fmt.Errorf("release manifest does not list %s", name)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != want {
		return Manifest{}, fmt.Errorf("%s does not match the signed release", name)
	}
	return m, nil
}
