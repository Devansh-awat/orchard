package commands

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"github.com/hackclub/orchard/orchardctl/internal/release"
)

type imageFixture struct {
	dir     string
	key     ed25519.PrivateKey
	public  string
	binary  []byte
	archive string
}

func fakeBinary(marker string) []byte {
	return append([]byte("\x7fELF"+marker), make([]byte, 2048)...)
}

func newImage(t *testing.T, version string) *imageFixture {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(publicKey)
	img := &imageFixture{
		dir:     t.TempDir(),
		key:     privateKey,
		public:  base64.StdEncoding.EncodeToString(der),
		binary:  fakeBinary("real"),
		archive: fmt.Sprintf("orchardctl-linux-%s", runtime.GOARCH),
	}
	img.write(t, img.archive, img.binary)
	img.sign(t, version, map[string][]byte{img.archive: img.binary})
	return img
}

func (img *imageFixture) write(t *testing.T, name string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(img.dir, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func (img *imageFixture) sign(t *testing.T, version string, files map[string][]byte) {
	t.Helper()
	manifest := release.BuildManifest(version, files)
	img.write(t, release.ManifestFile, manifest)
	img.write(t, release.SignatureFile, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(img.key, manifest))))
}

func imageKubectl(t *testing.T, image string) {
	t.Helper()
	bin := t.TempDir()
	script := "#!/bin/sh\nfor last; do :; done\nexec cat \"" + image + "/$(basename \"$last\")\"\n"
	if err := os.WriteFile(filepath.Join(bin, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func syncInto(t *testing.T, img *imageFixture, keys []string, version string, allowUnsigned bool) (string, string, error) {
	t.Helper()
	imageKubectl(t, img.dir)
	savedKeys, savedVersion := release.PublicKeys, release.Version
	release.PublicKeys, release.Version = keys, version
	t.Cleanup(func() { release.PublicKeys, release.Version = savedKeys, savedVersion })

	bin := t.TempDir()
	target := filepath.Join(bin, "orchardctl")
	if err := os.WriteFile(target, []byte("current"), 0o755); err != nil {
		t.Fatal(err)
	}
	log, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	c := &cli.Context{
		Stdout: log,
		Stderr: log,
		Env:    cli.Env{Bin: bin, Namespace: "orchard", AllowUnsignedCommands: allowUnsigned},
	}
	syncErr := syncCommands(c)
	installed, _ := os.ReadFile(target)
	out, _ := os.ReadFile(log.Name())
	return string(installed), string(out), syncErr
}

func TestSyncInstallsASignedRelease(t *testing.T) {
	img := newImage(t, "2.90.0")
	installed, _, err := syncInto(t, img, []string{img.public}, "2.89.0", false)
	if err != nil {
		t.Fatal(err)
	}
	if installed != string(img.binary) {
		t.Fatal("the signed binary should be installed")
	}
}

func TestSyncRefusesASwappedBinary(t *testing.T) {
	img := newImage(t, "2.90.0")
	img.write(t, img.archive, fakeBinary("evil"))
	installed, _, err := syncInto(t, img, []string{img.public}, "2.89.0", false)
	if err == nil || installed != "current" {
		t.Fatalf("a swapped binary was accepted: err=%v installed=%q", err, installed[:7])
	}
}

func TestSyncRefusesAnUnsignedImage(t *testing.T) {
	img := newImage(t, "2.90.0")
	public := img.public
	os.Remove(filepath.Join(img.dir, release.SignatureFile))
	installed, _, err := syncInto(t, img, []string{public}, "2.89.0", false)
	if err == nil || installed != "current" {
		t.Fatalf("an unsigned image was accepted: %v", err)
	}
}

func TestSyncRefusesAReSignedBinary(t *testing.T) {
	img := newImage(t, "2.90.0")
	trusted := img.public
	evil := newImage(t, "2.90.0")
	installed, _, err := syncInto(t, evil, []string{trusted}, "2.89.0", false)
	if err == nil || installed != "current" {
		t.Fatalf("a binary signed by another key was accepted: %v", err)
	}
}

func TestSyncKeepsTheCurrentCommandsOnAnOlderRelease(t *testing.T) {
	img := newImage(t, "2.80.0")
	installed, out, err := syncInto(t, img, []string{img.public}, "2.90.0", false)
	if err != nil {
		t.Fatal(err)
	}
	if installed != "current" || !strings.Contains(out, "keeping the current host commands") {
		t.Fatalf("an older signed release replaced the commands: %s", out)
	}
}

func TestSyncAllowsUnsignedImagesWhenTheOperatorSaysSo(t *testing.T) {
	img := newImage(t, "2.90.0")
	img.write(t, img.archive, fakeBinary("selfbuilt"))
	public := img.public
	installed, _, err := syncInto(t, img, []string{public}, "", true)
	if err != nil || !strings.Contains(installed, "selfbuilt") {
		t.Fatalf("err=%v", err)
	}
}

func TestSyncSkipsChecksUntilAKeyIsConfigured(t *testing.T) {
	img := newImage(t, "2.90.0")
	os.Remove(filepath.Join(img.dir, release.SignatureFile))
	installed, _, err := syncInto(t, img, nil, "", false)
	if err != nil || installed != string(img.binary) {
		t.Fatalf("err=%v", err)
	}
}

func shellKeys(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^RELEASE_KEYS="([^"]*)"`).FindSubmatch(raw)
	if match == nil {
		t.Fatalf("%s no longer declares RELEASE_KEYS", path)
	}
	return strings.Fields(string(match[1]))
}

func TestEveryPlaceTrustsTheSameKeys(t *testing.T) {
	want := strings.Join(release.PublicKeys, " ")
	if got := strings.Join(shellKeys(t, "../../../hostbin/orchard-sync-commands"), " "); got != want {
		t.Fatalf("orchard-sync-commands trusts %q, orchardctl trusts %q", got, want)
	}
	installer := shellKeys(t, "../../../../../install/install.sh")
	if len(installer) > 0 && strings.Join(installer, " ") != want {
		t.Fatalf("install.sh trusts %v, orchardctl trusts %q", installer, want)
	}
}

func runBootstrap(t *testing.T, img *imageFixture, extraEnv ...string) (string, string, error) {
	t.Helper()
	if _, err := exec.LookPath("sha256sum"); err != nil {
		t.Skip("needs sha256sum")
	}
	help, _ := exec.Command("openssl", "pkeyutl", "-help").CombinedOutput()
	if !bytes.Contains(help, []byte("rawin")) {
		t.Skip("needs an openssl with -rawin")
	}
	raw, err := os.ReadFile("../../../hostbin/orchard-sync-commands")
	if err != nil {
		t.Fatal(err)
	}
	script := strings.Replace(string(raw), `RELEASE_KEYS=""`, `RELEASE_KEYS="`+img.public+`"`, 1)
	dir := t.TempDir()
	path := filepath.Join(dir, "sync")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	imageKubectl(t, img.dir)
	bin := t.TempDir()
	cmd := exec.Command("bash", path)
	cmd.Env = append(os.Environ(), "ORCHARD_BIN="+bin, "ORCHARD_STATE_DIR="+dir)
	cmd.Env = append(cmd.Env, extraEnv...)
	out, err := cmd.CombinedOutput()
	installed, _ := os.ReadFile(filepath.Join(bin, "orchardctl"))
	return string(installed), string(out), err
}

func archFile() string {
	arch := runtime.GOARCH
	return "orchardctl-linux-" + arch
}

func TestBootstrapChecksTheSignature(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the bootstrap runs on linux hosts")
	}
	img := newImage(t, "2.90.0")
	if installed, out, err := runBootstrap(t, img); err != nil || installed != string(img.binary) {
		t.Fatalf("signed release refused: %v\n%s", err, out)
	}

	img.write(t, archFile(), fakeBinary("evil"))
	if installed, _, err := runBootstrap(t, img); err == nil || installed != "" {
		t.Fatal("the bootstrap installed a swapped binary")
	}
	if installed, _, err := runBootstrap(t, img, "ORCHARD_ALLOW_UNSIGNED_COMMANDS=true"); err != nil || !strings.Contains(installed, "evil") {
		t.Fatalf("the opt-out should allow it: %v", err)
	}

	unsigned := newImage(t, "2.90.0")
	os.Remove(filepath.Join(unsigned.dir, release.SignatureFile))
	if _, _, err := runBootstrap(t, unsigned); err == nil {
		t.Fatal("the bootstrap accepted an unsigned image")
	}
}
