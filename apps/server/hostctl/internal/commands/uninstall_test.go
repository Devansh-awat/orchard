package commands

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

type fakeHost struct {
	layout hostLayout
	keep   []string
	gone   []string
	env    cli.Env
}

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newFakeHost(t *testing.T) fakeHost {
	t.Helper()
	root := t.TempDir()
	at := func(parts ...string) string { return filepath.Join(append([]string{root}, parts...)...) }

	layout := hostLayout{
		StateDir:     at("etc", "orchard"),
		Bin:          at("usr", "local", "bin"),
		SystemBin:    at("usr", "local", "bin"),
		SystemdDir:   at("etc", "systemd", "system"),
		K3sUninstall: at("usr", "local", "bin", "k3s-uninstall.sh"),
		Rancher:      []string{at("etc", "rancher"), at("var", "lib", "rancher")},
		Homes:        []string{at("root")},
	}

	gone := []string{
		filepath.Join(layout.StateDir, "values.yaml"),
		filepath.Join(layout.StateDir, "env"),
		filepath.Join(layout.Bin, "orchardctl"),
		filepath.Join(layout.Bin, "orchard-sync-commands"),
		filepath.Join(layout.Bin, "helm"),
		filepath.Join(layout.Bin, "yq"),
		filepath.Join(layout.SystemdDir, updateTimerUnit),
		filepath.Join(layout.SystemdDir, updateServiceUnit),
		filepath.Join(layout.SystemdDir, "timers.target.wants", updateTimerUnit),
		at("etc", "rancher", "node", "password"),
		at("var", "lib", "rancher", "leftover"),
		at("root", ".kube", "cache", "discovery"),
		at("root", ".config", "helm", "repositories.yaml"),
		at("root", ".cache", "helm", "index"),
		at("root", ".local", "share", "helm", "plugins"),
	}
	for _, path := range gone {
		touch(t, path)
	}
	for _, alias := range append([]string{"orchard-retired"}, Aliases...) {
		link := filepath.Join(layout.Bin, alias)
		if err := os.Symlink(filepath.Join(layout.Bin, "orchardctl"), link); err != nil {
			t.Fatal(err)
		}
		gone = append(gone, link)
	}

	keep := []string{
		filepath.Join(layout.Bin, "orchard-mine"),
		filepath.Join(layout.Bin, "unrelated"),
		at("etc", "hosts"),
		at("root", ".config", "other", "settings"),
	}
	for _, path := range keep {
		touch(t, path)
	}
	foreign := filepath.Join(layout.Bin, "orchard-elsewhere")
	if err := os.Symlink(at("etc", "hosts"), foreign); err != nil {
		t.Fatal(err)
	}
	keep = append(keep, foreign)
	touch(t, layout.K3sUninstall)

	values := filepath.Join(layout.StateDir, "values.yaml")
	if err := os.WriteFile(values, []byte("ingress:\n  host: orchard.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return fakeHost{
		layout: layout,
		keep:   keep,
		gone:   gone,
		env:    cli.Env{StateDir: layout.StateDir, Values: values, Bin: layout.Bin},
	}
}

func typeAtPrompt(t *testing.T, answer string) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.WriteString(answer); err != nil {
		t.Fatal(err)
	}
	w.Close()
	stdin := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = stdin
		r.Close()
	})
}

func quietContext(t *testing.T, env cli.Env) *cli.Context {
	t.Helper()
	sink, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sink.Close() })
	return &cli.Context{Env: env, Stdout: sink, Stderr: sink}
}

func assertAll(t *testing.T, paths []string, exists bool) {
	t.Helper()
	for _, path := range paths {
		if pathExists(path) != exists {
			t.Errorf("%s: exists = %v, want %v", path, !exists, exists)
		}
	}
}

func TestUninstallRemovesWhatK3sUninstallLeavesBehind(t *testing.T) {
	host := newFakeHost(t)
	typeAtPrompt(t, "delete orchard.example.com\n")

	var calls [][]string
	run := func(name string, args ...string) error {
		calls = append(calls, append([]string{name}, args...))
		return nil
	}
	if err := runUninstall(quietContext(t, host.env), host.layout, run); err != nil {
		t.Fatal(err)
	}

	assertAll(t, host.gone, false)
	assertAll(t, []string{host.layout.StateDir, filepath.Join(host.layout.Bin, "orchardctl")}, false)
	assertAll(t, host.keep, true)

	want := [][]string{
		{"systemctl", "disable", "--now", updateTimerUnit},
		{"systemctl", "stop", updateServiceUnit},
		{"systemctl", "daemon-reload"},
		{host.layout.K3sUninstall},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("ran %v, want %v", calls, want)
	}
}

func TestUninstallChangesNothingWithoutTheExactPhrase(t *testing.T) {
	for _, answer := range []string{"", "\n", "yes\n", "delete\n", "delete other.example.com\n"} {
		host := newFakeHost(t)
		typeAtPrompt(t, answer)

		run := func(name string, args ...string) error {
			t.Fatalf("ran %s after the answer %q", name, answer)
			return nil
		}
		if err := runUninstall(quietContext(t, host.env), host.layout, run); err == nil {
			t.Fatalf("answer %q went through", answer)
		}
		assertAll(t, host.gone, true)
	}
}

func TestUninstallKeepsItsCommandsWhenK3sFails(t *testing.T) {
	host := newFakeHost(t)
	typeAtPrompt(t, "delete orchard.example.com\n")

	run := func(name string, args ...string) error {
		if name == host.layout.K3sUninstall {
			return errors.New("boom")
		}
		return nil
	}
	if err := runUninstall(quietContext(t, host.env), host.layout, run); err == nil {
		t.Fatal("a failed k3s uninstall should be an error")
	}
	assertAll(t, []string{
		filepath.Join(host.layout.Bin, "orchardctl"),
		filepath.Join(host.layout.StateDir, "values.yaml"),
	}, true)
}

func TestUninstallPhraseFallsBackWithoutValues(t *testing.T) {
	want, err := os.Hostname()
	if err != nil {
		t.Skip("no hostname here")
	}
	if got := uninstallPhrase(filepath.Join(t.TempDir(), "missing.yaml")); got != "delete "+want {
		t.Fatalf("got %q", got)
	}
}

func TestRemoveLeftoverRefusesShallowPaths(t *testing.T) {
	c := quietContext(t, cli.Env{})
	for _, path := range []string{"", "/", "/etc", "relative/path"} {
		if removeLeftover(c, path) {
			t.Errorf("removed %q", path)
		}
	}
}
