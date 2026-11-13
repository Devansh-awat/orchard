package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

type imageGCBox struct {
	host  imageGCHost
	calls *[]string
	c     *cli.Context
	root  string
}

func newImageGCBox(t *testing.T) imageGCBox {
	t.Helper()
	root := t.TempDir()
	agentEtc := filepath.Join(root, "var", "agent", "etc")
	if err := os.MkdirAll(agentEtc, 0o755); err != nil {
		t.Fatal(err)
	}
	k3sConfig := filepath.Join(root, "etc", "k3s")
	if err := os.MkdirAll(filepath.Join(k3sConfig, "config.yaml.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	sink, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sink.Close() })
	calls := &[]string{}
	return imageGCBox{
		host: imageGCHost{
			path:      filepath.Join(agentEtc, "kubelet.conf.d", "05-orchard-image-gc.conf"),
			k3sConfig: k3sConfig,
			unitPath:  filepath.Join(root, "k3s.service"),
			imageDir:  root,
			managed:   true,
			run: func(name string, args ...string) error {
				*calls = append(*calls, strings.Join(append([]string{name}, args...), " "))
				return nil
			},
		},
		calls: calls,
		c:     &cli.Context{Stdout: sink, Stderr: sink},
		root:  root,
	}
}

func (b imageGCBox) restarts() int {
	n := 0
	for _, call := range *b.calls {
		if call == "systemctl restart k3s" {
			n++
		}
	}
	return n
}

func (b imageGCBox) file(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(b.host.path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestImageGCDefaultsAreAKubeletDropIn(t *testing.T) {
	want := `apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: 70
imageGCLowThresholdPercent: 50
imageMaximumGCAge: 72h
`
	if got := orchardImageGC.conf(); got != want {
		t.Fatalf("got:\n%s", got)
	}
	if err := orchardImageGC.validate(); err != nil {
		t.Fatal(err)
	}
}

func TestInstallerWritesTheSameDropIn(t *testing.T) {
	out, err := exec.Command("bash", "-c", installerFunctions(t, "image_gc_conf")+"image_gc_conf\n").CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if string(out) != orchardImageGC.conf() {
		t.Fatalf("install.sh writes:\n%s\norchardctl writes:\n%s", out, orchardImageGC.conf())
	}
}

func TestImageGCConfRoundTrips(t *testing.T) {
	for _, g := range []imageGC{orchardImageGC, {High: 90, Low: 10, MaxAge: 0}, {High: 60, Low: 40, MaxAge: 90 * time.Minute}} {
		got, err := parseImageGCConf([]byte(g.conf()))
		if err != nil || got != g {
			t.Errorf("%+v: got %+v %v", g, got, err)
		}
	}
	got, err := parseImageGCConf([]byte("apiVersion: kubelet.config.k8s.io/v1beta1\nkind: KubeletConfiguration\nimageGCHighThresholdPercent: 75\n"))
	if err != nil || got != (imageGC{High: 75, Low: 80}) {
		t.Errorf("missing fields should be the kubelet's defaults: got %+v %v", got, err)
	}
}

func TestImageGCRejectsSettingsTheKubeletWouldRefuse(t *testing.T) {
	for _, g := range []imageGC{
		{High: 50, Low: 50, MaxAge: 72 * time.Hour},
		{High: 50, Low: 60, MaxAge: 72 * time.Hour},
		{High: 100, Low: 50, MaxAge: 72 * time.Hour},
		{High: 70, Low: 0, MaxAge: 72 * time.Hour},
		{High: 70, Low: 50, MaxAge: 2 * time.Minute},
		{High: 70, Low: 50, MaxAge: 400 * 24 * time.Hour},
	} {
		if err := g.validate(); err == nil {
			t.Errorf("%+v was accepted", g)
		}
	}
}

func TestImageAgeTakesDaysHoursAndOff(t *testing.T) {
	for raw, want := range map[string]time.Duration{
		"72h":   72 * time.Hour,
		"3d":    72 * time.Hour,
		"1.5d":  36 * time.Hour,
		"90m":   90 * time.Minute,
		"off":   0,
		"never": 0,
		"0":     0,
	} {
		got, err := parseImageAge(raw)
		if err != nil || got != want {
			t.Errorf("%q: got %s %v", raw, got, err)
		}
	}
	for _, raw := range []string{"", "soon", "-3h", "3x", "d"} {
		if _, err := parseImageAge(raw); err == nil {
			t.Errorf("%q parsed", raw)
		}
	}
}

func TestImageGCFlagsChangeOnlyWhatIsGiven(t *testing.T) {
	got, err := parseImageGCFlags([]string{"--high", "80", "--low=60%"}, orchardImageGC)
	if err != nil || got != (imageGC{High: 80, Low: 60, MaxAge: 72 * time.Hour}) {
		t.Fatalf("got %+v %v", got, err)
	}
	got, err = parseImageGCFlags([]string{"--max-age", "off"}, orchardImageGC)
	if err != nil || got != (imageGC{High: 70, Low: 50}) {
		t.Fatalf("got %+v %v", got, err)
	}
	for _, args := range [][]string{nil, {"--high"}, {"--high", "lots"}, {"--low", "75"}, {"--bogus", "1"}, {"80"}} {
		if _, err := parseImageGCFlags(args, orchardImageGC); err == nil {
			t.Errorf("%v was accepted", args)
		}
	}
}

func TestImageGCSetRestartsK3sOnlyWhenTheFileChanges(t *testing.T) {
	b := newImageGCBox(t)
	if err := b.host.command(b.c, []string{"set", "--max-age", "7d"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.file(t), "imageMaximumGCAge: 168h\n") || !strings.Contains(b.file(t), "imageGCHighThresholdPercent: 70\n") {
		t.Fatalf("a first set starts from Orchard's defaults:\n%s", b.file(t))
	}
	if b.restarts() != 1 {
		t.Fatalf("calls = %v", *b.calls)
	}
	info, err := os.Stat(b.host.path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v %v", info, err)
	}
	dir, err := os.Stat(filepath.Dir(b.host.path))
	if err != nil || dir.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode = %v %v", dir, err)
	}

	if err := b.host.command(b.c, []string{"set", "--max-age", "168h"}); err != nil {
		t.Fatal(err)
	}
	if b.restarts() != 1 {
		t.Fatalf("an unchanged file shouldn't restart k3s: %v", *b.calls)
	}

	if err := b.host.command(b.c, []string{"set", "--high", "80"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.file(t), "imageGCHighThresholdPercent: 80\n") || !strings.Contains(b.file(t), "imageMaximumGCAge: 168h\n") {
		t.Fatalf("set should keep what it wasn't given:\n%s", b.file(t))
	}
	if b.restarts() != 2 {
		t.Fatalf("calls = %v", *b.calls)
	}

	if err := b.host.command(b.c, []string{"reset"}); err != nil {
		t.Fatal(err)
	}
	if b.file(t) != orchardImageGC.conf() || b.restarts() != 3 {
		t.Fatalf("reset: %v\n%s", *b.calls, b.file(t))
	}
}

func TestImageGCSetLeavesTheFileAloneOnBadInput(t *testing.T) {
	b := newImageGCBox(t)
	if err := b.host.command(b.c, []string{"set", "--low", "90"}); err == nil {
		t.Fatal("low above high was accepted")
	}
	if _, err := os.Stat(b.host.path); !os.IsNotExist(err) || len(*b.calls) != 0 {
		t.Fatalf("nothing should be written or run: %v %v", err, *b.calls)
	}
}

func TestImageGCNeedsK3sAgentConfiguration(t *testing.T) {
	b := newImageGCBox(t)
	if err := os.RemoveAll(filepath.Join(b.root, "var")); err != nil {
		t.Fatal(err)
	}
	if err := b.host.command(b.c, []string{"reset"}); err == nil {
		t.Fatal("wrote a drop-in no kubelet reads")
	}
}

func TestUpdateWritesImageGCDefaultsOnce(t *testing.T) {
	b := newImageGCBox(t)
	b.host.ensureDefaults(b.c)
	if b.file(t) != orchardImageGC.conf() || b.restarts() != 1 {
		t.Fatalf("calls = %v\n%s", *b.calls, b.file(t))
	}
	if len(*b.calls) != 2 || !strings.HasPrefix((*b.calls)[1], "kubectl wait --for=condition=Ready node") {
		t.Fatalf("the restart should wait for the node: %v", *b.calls)
	}

	tuned := imageGC{High: 90, Low: 85}.conf()
	if err := os.WriteFile(b.host.path, []byte(tuned), 0o600); err != nil {
		t.Fatal(err)
	}
	b.host.ensureDefaults(b.c)
	if b.file(t) != tuned || b.restarts() != 1 {
		t.Fatalf("a tuned file was touched: %v\n%s", *b.calls, b.file(t))
	}
}

func TestUpdateSkipsImageGCWithoutK3s(t *testing.T) {
	b := newImageGCBox(t)
	b.host.managed = false
	b.host.ensureDefaults(b.c)
	if _, err := os.Stat(b.host.path); !os.IsNotExist(err) || len(*b.calls) != 0 {
		t.Fatalf("%v %v", err, *b.calls)
	}
}

func TestImageGCFindsSettingsThatWinOverIt(t *testing.T) {
	b := newImageGCBox(t)
	dir := filepath.Dir(b.host.path)
	if err := os.MkdirAll(filepath.Join(dir, "20-cli-config-dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		filepath.Join(b.host.k3sConfig, "config.yaml"):                "kubelet-arg:\n  - image-gc-high-threshold=95\n",
		filepath.Join(b.host.k3sConfig, "config.yaml.d", "10-a.yaml"): "write-kubeconfig-mode: \"0600\"\n",
		filepath.Join(dir, "00-k3s-defaults.conf"):                    "imageMinimumGCAge: 2m0s\n",
		filepath.Join(dir, "01-early.conf"):                           "imageGCHighThresholdPercent: 60\n",
		filepath.Join(dir, "20-cli-config-dir", "custom.conf"):        "imageMaximumGCAge: 1h\n",
		filepath.Join(dir, "99-notes.txt"):                            "imageMaximumGCAge: 1h\n",
		b.host.path:                                                   orchardImageGC.conf(),
		b.host.unitPath:                                               "ExecStart=/usr/local/bin/k3s server --disable=traefik\n",
	}
	for path, body := range files {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got := b.host.overrides()
	want := []string{
		filepath.Join(b.host.k3sConfig, "config.yaml"),
		filepath.Join(dir, "20-cli-config-dir", "custom.conf"),
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got %v", got)
	}
}

func TestImageGCPruneRemovesUnusedImages(t *testing.T) {
	b := newImageGCBox(t)
	if err := b.host.command(b.c, []string{"prune"}); err != nil {
		t.Fatal(err)
	}
	if len(*b.calls) != 1 || (*b.calls)[0] != k3sBinary+" crictl rmi --prune" {
		t.Fatalf("calls = %v", *b.calls)
	}
	b.host.managed = false
	if err := b.host.command(b.c, []string{"prune"}); err == nil {
		t.Fatal("pruned without k3s")
	}
}

func TestImageGCStatusReadsWithoutWriting(t *testing.T) {
	b := newImageGCBox(t)
	b.host.managed = false
	if err := b.host.command(b.c, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(b.host.path); !os.IsNotExist(err) || len(*b.calls) != 0 {
		t.Fatalf("%v %v", err, *b.calls)
	}
	if err := b.host.command(b.c, []string{"compact"}); err == nil {
		t.Fatal("an unknown action was accepted")
	}
}
