package release

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"testing"
)

func keypair(t *testing.T) (ed25519.PrivateKey, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return private, base64.StdEncoding.EncodeToString(der)
}

func sign(key ed25519.PrivateKey, manifest []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest))
}

func TestVerify(t *testing.T) {
	key, public := keypair(t)
	_, other := keypair(t)
	binary := []byte("the real binary")
	manifest := BuildManifest("2.90.0", map[string][]byte{"orchardctl-linux-amd64": binary})
	signature := sign(key, manifest)

	m, err := Verify([]string{other, public}, manifest, signature, "orchardctl-linux-amd64", binary)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "2.90.0" {
		t.Fatalf("version %q", m.Version)
	}

	for name, try := range map[string]func() error{
		"swapped binary": func() error {
			_, err := Verify([]string{public}, manifest, signature, "orchardctl-linux-amd64", []byte("evil"))
			return err
		},
		"edited manifest": func() error {
			edited := BuildManifest("2.90.0", map[string][]byte{"orchardctl-linux-amd64": []byte("evil")})
			_, err := Verify([]string{public}, edited, signature, "orchardctl-linux-amd64", []byte("evil"))
			return err
		},
		"attacker's own key": func() error {
			evil, _ := keypair(t)
			_, err := Verify([]string{public}, manifest, sign(evil, manifest), "orchardctl-linux-amd64", binary)
			return err
		},
		"no signature": func() error {
			_, err := Verify([]string{public}, manifest, "", "orchardctl-linux-amd64", binary)
			return err
		},
		"unlisted file": func() error {
			_, err := Verify([]string{public}, manifest, signature, "orchardctl-linux-arm64", binary)
			return err
		},
		"no trusted keys": func() error {
			_, err := Verify(nil, manifest, signature, "orchardctl-linux-amd64", binary)
			return err
		},
	} {
		if try() == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestManifestHasNoTrailingNewline(t *testing.T) {
	manifest := BuildManifest("1.0.0", map[string][]byte{"a": []byte("x")})
	if manifest[len(manifest)-1] == '\n' {
		t.Fatal("a trailing newline would not survive being read back through a shell")
	}
}

func TestConfiguredKeysParse(t *testing.T) {
	if len(PublicKeys) == 0 {
		t.Fatal("no release keys are configured")
	}
	for _, encoded := range PublicKeys {
		if _, err := parsePublicKey(encoded); err != nil {
			t.Fatalf("%s: %v", encoded, err)
		}
	}
}
