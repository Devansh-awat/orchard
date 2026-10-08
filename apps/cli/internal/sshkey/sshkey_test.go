package sshkey

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateShape(t *testing.T) {
	priv, pub, err := Generate("orchard-cli@test")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !strings.HasPrefix(string(priv), "-----BEGIN OPENSSH PRIVATE KEY-----\n") {
		t.Errorf("private key header = %q", strings.SplitN(string(priv), "\n", 2)[0])
	}
	fields := strings.Fields(pub)
	if len(fields) != 3 || fields[0] != "ssh-ed25519" || fields[2] != "orchard-cli@test" {
		t.Errorf("public key = %q", pub)
	}
}

func TestSameKeyIgnoresComment(t *testing.T) {
	if !SameKey("ssh-ed25519 AAAA one", "ssh-ed25519 AAAA two") {
		t.Error("same material with different comments should match")
	}
	if SameKey("ssh-ed25519 AAAA", "ssh-ed25519 BBBB") || SameKey("ssh-ed25519", "ssh-ed25519") {
		t.Error("different or malformed keys must not match")
	}
}

func TestGenerateRoundTripsThroughSSHKeygen(t *testing.T) {
	bin, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen not on PATH")
	}
	priv, pub, err := Generate("orchard-cli@test")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	path := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(path, priv, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	out, err := exec.Command(bin, "-y", "-f", path).CombinedOutput()
	if err != nil {
		t.Fatalf("ssh-keygen -y: %v\n%s", err, out)
	}
	if !SameKey(string(out), pub) {
		t.Fatalf("ssh-keygen derived %q, want %q", strings.TrimSpace(string(out)), pub)
	}
}

func TestAuthorizedKeyFromPrivate(t *testing.T) {
	priv, pub, err := Generate("c")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	got, err := AuthorizedKeyFromPrivate(priv, "c")
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if got != pub {
		t.Fatalf("derived %q, want %q", got, pub)
	}
	if _, err := AuthorizedKeyFromPrivate([]byte("garbage"), ""); err == nil {
		t.Fatal("garbage must not parse")
	}
}
