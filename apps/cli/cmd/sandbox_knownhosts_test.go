package cmd

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func hashedKnownHost(salt []byte, host string) string {
	mac := hmac.New(sha1.New, salt)
	mac.Write([]byte(host))
	return "|1|" + base64.StdEncoding.EncodeToString(salt) + "|" + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestRewriteKnownHostsReplacesOnlyTheAlias(t *testing.T) {
	hashedBox := hashedKnownHost([]byte("0123456789abcdefghij"), "orchard-box")
	hashedOther := hashedKnownHost([]byte("abcdefghij0123456789"), "orchard-other")
	in := "# pinned by orchard\n" +
		"orchard-box ssh-ed25519 OLD1\n" +
		hashedBox + " ssh-rsa OLD2\n" +
		"orchard-box,10.0.0.1 ecdsa-sha2-nistp256 OLD3\n" +
		hashedOther + " ssh-ed25519 KEEP1\n" +
		"orchard-boxer ssh-ed25519 KEEP2\n" +
		"@revoked orchard-box ssh-ed25519 REVOKED\n"
	got := rewriteKnownHosts(in, "orchard-box", []string{"ssh-ed25519 NEW1", "ssh-rsa NEW2"})
	want := "# pinned by orchard\n" +
		hashedOther + " ssh-ed25519 KEEP1\n" +
		"orchard-boxer ssh-ed25519 KEEP2\n" +
		"@revoked orchard-box ssh-ed25519 REVOKED\n" +
		"orchard-box ssh-ed25519 NEW1\n" +
		"orchard-box ssh-rsa NEW2\n"
	if got != want {
		t.Errorf("rewrite:\n%s\nwant:\n%s", got, want)
	}
}

func TestSyncKnownHosts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ssh", "known_hosts")
	changed, err := syncKnownHosts(path, "orchard-box", nil)
	if err != nil || changed {
		t.Fatalf("no keys: changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("no keys should not create the file, stat err = %v", err)
	}
	keys := []string{"ssh-ed25519 AAAA"}
	changed, err = syncKnownHosts(path, "orchard-box", keys)
	if err != nil || !changed {
		t.Fatalf("first sync: changed=%v err=%v", changed, err)
	}
	if got := readFile(t, path); got != "orchard-box ssh-ed25519 AAAA\n" {
		t.Errorf("known_hosts = %q", got)
	}
	assertPerm(t, path, 0o600)
	changed, err = syncKnownHosts(path, "orchard-box", keys)
	if err != nil || changed {
		t.Fatalf("second sync should be a no-op: changed=%v err=%v", changed, err)
	}
	changed, err = syncKnownHosts(path, "orchard-box", []string{"ssh-ed25519 BBBB"})
	if err != nil || !changed {
		t.Fatalf("rotated key: changed=%v err=%v", changed, err)
	}
	if got := readFile(t, path); got != "orchard-box ssh-ed25519 BBBB\n" {
		t.Errorf("known_hosts after rotation = %q", got)
	}
}

func TestSSHHostKeyAlias(t *testing.T) {
	cases := map[string]string{
		"orchard-box":     "orchard-box",
		"dev@Orchard-Box": "orchard-box",
		" orchard-box\n":  "orchard-box",
	}
	for in, want := range cases {
		if got := sshHostKeyAlias(in); got != want {
			t.Errorf("sshHostKeyAlias(%q) = %q, want %q", in, got, want)
		}
	}
}
