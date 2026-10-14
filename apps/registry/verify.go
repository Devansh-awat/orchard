package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"
)

const (
	maxGraftSize     = 64 << 20
	maxGraftUnpacked = 512 << 20
)

var officialGraftKeys = []string{"b5IPbzjTG0mMm/fikc3WGi/PQhuC8cEOlt4WHodoihI="}

var publicSchemaRe = regexp.MustCompile(`(?i)\b(create|alter|drop|truncate|insert\s+into|update|delete\s+from)\s+(table\s+|index\s+|view\s+|type\s+)?(if\s+(not\s+)?exists\s+)?(public|"public")\.`)

var errUnsigned = errors.New("it has no MANIFEST.sig")

func keyID(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:16]
}

func parsePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("public keys must be 32-byte ed25519 keys in base64")
	}
	return ed25519.PublicKey(raw), nil
}

func isOfficialKey(pub ed25519.PublicKey) bool {
	for _, k := range officialGraftKeys {
		if official, err := parsePublicKey(k); err == nil && official.Equal(pub) {
			return true
		}
	}
	return false
}

func parseSigningKey(value string) (ed25519.PrivateKey, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, errors.New("GRAFT_SIGNING_KEY is empty")
	}
	pemBytes := []byte(value)
	if !strings.Contains(value, "-----BEGIN") {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("GRAFT_SIGNING_KEY is neither a PEM nor base64 of one: %w", err)
		}
		pemBytes = decoded
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("GRAFT_SIGNING_KEY does not hold a PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("GRAFT_SIGNING_KEY is not a PKCS8 private key: %w", err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("GRAFT_SIGNING_KEY is not an ed25519 key")
	}
	return key, nil
}

func signDetached(key ed25519.PrivateKey, body []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, body)) + "\n")
}

func untarGraft(raw []byte) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	var total int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg:
		case tar.TypeSymlink, tar.TypeLink:
			return nil, fmt.Errorf("graft contains a link: %s", hdr.Name)
		default:
			return nil, fmt.Errorf("graft contains an entry that is not a file: %s", hdr.Name)
		}
		name := hdr.Name
		if name == "" || path.IsAbs(name) || path.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") {
			return nil, fmt.Errorf("graft contains an unsafe path: %q", name)
		}
		if _, dup := files[name]; dup {
			return nil, fmt.Errorf("graft contains %s twice", name)
		}
		total += hdr.Size
		if hdr.Size < 0 || total > maxGraftUnpacked {
			return nil, errors.New("graft unpacks to more than 512 MiB")
		}
		body, err := io.ReadAll(io.LimitReader(tr, hdr.Size))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		files[name] = body
	}
	return files, nil
}

func verifyFileManifest(files map[string][]byte) error {
	body, ok := files["MANIFEST.json"]
	if !ok {
		return errors.New("MANIFEST.json is missing")
	}
	var manifest struct {
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		return fmt.Errorf("MANIFEST.json is unreadable: %w", err)
	}
	if manifest.Files == nil {
		return errors.New("MANIFEST.json has no files map")
	}
	var missing, unlisted, mismatched, reserved []string
	for name := range manifest.Files {
		if _, ok := files[name]; !ok || name == "MANIFEST.json" || name == "MANIFEST.sig" {
			missing = append(missing, name)
		}
	}
	for name, content := range files {
		if name == "MANIFEST.json" || name == "MANIFEST.sig" {
			continue
		}
		if strings.HasPrefix(name, ".origin.") || strings.HasPrefix(name, ".listing.") {
			reserved = append(reserved, name)
		}
		want, ok := manifest.Files[name]
		if !ok {
			unlisted = append(unlisted, name)
			continue
		}
		if sha256Hex(content) != want {
			mismatched = append(mismatched, name)
		}
	}
	for _, list := range [][]string{missing, unlisted, mismatched, reserved} {
		sort.Strings(list)
	}
	switch {
	case len(reserved) > 0:
		return fmt.Errorf("graft ships files Orchard writes itself: %s", strings.Join(reserved, ", "))
	case len(missing) > 0:
		return fmt.Errorf("files listed in MANIFEST.json are missing: %s", strings.Join(missing, ", "))
	case len(unlisted) > 0:
		return fmt.Errorf("files not covered by MANIFEST.json: %s", strings.Join(unlisted, ", "))
	case len(mismatched) > 0:
		return fmt.Errorf("files do not match their MANIFEST.json hash: %s", strings.Join(mismatched, ", "))
	}
	return nil
}

func manifestSigner(files map[string][]byte, keys []string) (string, error) {
	sig, ok := files["MANIFEST.sig"]
	if !ok {
		return "", errUnsigned
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil {
		return "", errors.New("MANIFEST.sig is not base64")
	}
	message := files["MANIFEST.json"]
	for _, k := range keys {
		pub, err := parsePublicKey(k)
		if err != nil {
			continue
		}
		if ed25519.Verify(pub, message, decoded) {
			return keyID(pub), nil
		}
	}
	return "", errors.New("MANIFEST.sig does not verify against the expected key")
}

func adoptsCoreTables(d graftDoc) bool {
	v, ok := d.Database["adopts"]
	if !ok || v == nil {
		return false
	}
	list, isList := v.([]any)
	return !isList || len(list) > 0
}

func publicSchemaMigrations(files map[string][]byte) []string {
	var out []string
	for name, body := range files {
		if strings.HasPrefix(name, "migrations/") && strings.HasSuffix(name, ".sql") && publicSchemaRe.Match(body) {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

func checkCommunityGraft(a graftArtifact, l communityListing, version string) (string, error) {
	if a.doc.ID != l.ID {
		return "", fmt.Errorf("graft.json says id %q, the listing is for %q", a.doc.ID, l.ID)
	}
	if a.doc.Version != version {
		return "", fmt.Errorf("graft.json says version %s, the asset name says %s", a.doc.Version, version)
	}
	if a.doc.Publisher != l.Publisher {
		return "", fmt.Errorf("graft.json says publisher %q, the listing is for %q", a.doc.Publisher, l.Publisher)
	}
	if err := verifyFileManifest(a.files); err != nil {
		return "", err
	}
	signer, err := manifestSigner(a.files, []string{l.PublicKey})
	if err != nil {
		return "", fmt.Errorf("signature: %w", err)
	}
	if adoptsCoreTables(a.doc) {
		return "", errors.New("database.adopts is set; only official grafts may take over core tables")
	}
	if bad := publicSchemaMigrations(a.files); len(bad) > 0 {
		return "", fmt.Errorf("migrations change the public schema: %s", strings.Join(bad, ", "))
	}
	return signer, nil
}
