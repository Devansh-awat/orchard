package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/release"
)

func setup(t *testing.T) (dir, keyFile, public string) {
	t.Helper()
	dir = t.TempDir()
	for _, name := range signed {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("contents of "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(privateKey)
	encoded := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	keyFile = filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(publicKey)
	return dir, keyFile, base64.StdEncoding.EncodeToString(spki)
}

func withKeys(t *testing.T, keys []string) {
	t.Helper()
	saved := release.PublicKeys
	release.PublicKeys = keys
	t.Cleanup(func() { release.PublicKeys = saved })
}

func TestSignsAndVerifies(t *testing.T) {
	dir, keyFile, public := setup(t)
	withKeys(t, []string{public})
	if err := run(dir, "2.90.0", keyFile, true); err != nil {
		t.Fatal(err)
	}
	manifest, _ := os.ReadFile(filepath.Join(dir, release.ManifestFile))
	signature, _ := os.ReadFile(filepath.Join(dir, release.SignatureFile))
	data, _ := os.ReadFile(filepath.Join(dir, "orchard-sync-commands"))
	if _, err := release.Verify([]string{public}, manifest, string(signature), "orchard-sync-commands", data); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseBuildWithoutAKeyFails(t *testing.T) {
	dir, _, public := setup(t)
	withKeys(t, []string{public})
	if err := run(dir, "2.90.0", filepath.Join(dir, "absent"), true); err == nil {
		t.Fatal("a release that hosts would refuse must not build")
	}
}

func TestLocalBuildWithoutAKeyStaysUnsigned(t *testing.T) {
	dir, _, public := setup(t)
	withKeys(t, []string{public})
	if err := run(dir, "", filepath.Join(dir, "absent"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, release.SignatureFile)); err == nil {
		t.Fatal("no signature should be written")
	}
	if _, err := os.Stat(filepath.Join(dir, release.ManifestFile)); err != nil {
		t.Fatal("the image build copies the manifest, so it must exist")
	}
}

func TestAKeyOrchardctlDoesNotTrustFails(t *testing.T) {
	dir, keyFile, _ := setup(t)
	_, _, other := setup(t)
	withKeys(t, []string{other})
	if err := run(dir, "2.90.0", keyFile, true); err == nil {
		t.Fatal("signing with an untrusted key would break every host")
	}
}

func TestSigningBeforeAnyKeyIsTrusted(t *testing.T) {
	dir, keyFile, _ := setup(t)
	withKeys(t, nil)
	if err := run(dir, "2.90.0", keyFile, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, release.SignatureFile)); err != nil {
		t.Fatal("images should be signed before hosts start checking")
	}
}
