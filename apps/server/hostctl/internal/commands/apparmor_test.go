package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func apparmorFixture(t *testing.T, stacking string, withAbi bool) (*cli.Context, string, string) {
	t.Helper()
	root := t.TempDir()
	proc := filepath.Join(root, "proc")
	if err := os.WriteFile(proc, []byte(stacking), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "apparmor.d")
	if err := os.MkdirAll(filepath.Join(dir, "abstractions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if withAbi {
		if err := os.MkdirAll(filepath.Join(dir, "abi"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	sink, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sink.Close() })
	return &cli.Context{Stdout: sink, Stderr: sink}, proc, dir
}

func TestAllowContainerSignalsLoadsStackedProfile(t *testing.T) {
	c, proc, dir := apparmorFixture(t, "1\n", true)
	var calls []string
	allowContainerSignals(c, proc, dir, func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil
	})
	file := filepath.Join(dir, containerdProfile)
	got, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != containerdProfileText {
		t.Fatalf("profile = %q", got)
	}
	for _, rule := range []string{
		"signal (send,receive) peer=cri-containerd.apparmor.d,",
		"signal (send,receive) peer=cri-containerd.apparmor.d//&unconfined,",
		"ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d//&unconfined,",
	} {
		if !strings.Contains(string(got), rule) {
			t.Fatalf("profile is missing %q", rule)
		}
	}
	if strings.Contains(string(got), "//&*") {
		t.Fatal("profile allows a wildcard stacked peer")
	}
	if len(calls) != 1 || calls[0] != "apparmor_parser -r -W "+file {
		t.Fatalf("calls = %v", calls)
	}
}

func TestAllowContainerSignalsLeavesOtherHostsAlone(t *testing.T) {
	cases := map[string]struct {
		stacking string
		abi      bool
	}{
		"no stacking":        {"0\n", true},
		"no abi files":       {"1\n", false},
		"no stacking sysctl": {"", true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c, proc, dir := apparmorFixture(t, tc.stacking, tc.abi)
			if tc.stacking == "" {
				proc = filepath.Join(dir, "missing")
			}
			called := false
			allowContainerSignals(c, proc, dir, func(string, ...string) error {
				called = true
				return nil
			})
			if called {
				t.Fatal("apparmor_parser ran")
			}
			if _, err := os.Stat(filepath.Join(dir, containerdProfile)); err == nil {
				t.Fatal("profile written")
			}
		})
	}
}

func TestContainerdProfileMatchesInstaller(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "install", "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	_, rest, ok := strings.Cut(string(script), "cat <<'PROFILE'\n")
	if !ok {
		t.Fatal("install.sh has no PROFILE heredoc")
	}
	body, _, ok := strings.Cut(rest, "PROFILE\n")
	if !ok {
		t.Fatal("PROFILE heredoc is not closed")
	}
	if body != containerdProfileText {
		t.Fatal("install.sh and orchardctl write different containerd AppArmor profiles")
	}
}
