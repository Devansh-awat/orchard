package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func usernsFixture(t *testing.T, proc, values string) (*cli.Context, string, string, *[]string) {
	t.Helper()
	dir := t.TempDir()
	procPath := filepath.Join(dir, "proc")
	if err := os.WriteFile(procPath, []byte(proc), 0o644); err != nil {
		t.Fatal(err)
	}
	valuesPath := filepath.Join(dir, "values.yaml")
	if err := os.WriteFile(valuesPath, []byte(values), 0o600); err != nil {
		t.Fatal(err)
	}
	sink, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sink.Close() })
	c := &cli.Context{Env: cli.Env{Values: valuesPath}, Stdout: sink, Stderr: sink}
	return c, procPath, filepath.Join(dir, "builds.conf"), &[]string{}
}

func TestAllowRootlessBuildsWritesAndApplies(t *testing.T) {
	c, proc, conf, calls := usernsFixture(t, "1\n", "signupMode: invite_only\n")
	allowRootlessBuilds(c, proc, conf, func(name string, args ...string) error {
		*calls = append(*calls, name+" "+strings.Join(args, " "))
		return nil
	})
	got, err := os.ReadFile(conf)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != usernsSysctl+" = 0\n" {
		t.Fatalf("conf = %q", got)
	}
	if len(*calls) != 1 || !strings.Contains((*calls)[0], usernsSysctl+"=0") {
		t.Fatalf("calls = %v", *calls)
	}
}

func TestAllowRootlessBuildsLeavesOtherHostsAlone(t *testing.T) {
	cases := map[string][2]string{
		"already allowed":   {"0\n", "signupMode: invite_only\n"},
		"sandboxed builds":  {"1\n", "builderSandbox:\n  enabled: true\n"},
		"privileged builds": {"1\n", "builders:\n  allowPrivilegedOnHost: true\n"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c, proc, conf, calls := usernsFixture(t, tc[0], tc[1])
			allowRootlessBuilds(c, proc, conf, func(name string, args ...string) error {
				*calls = append(*calls, name)
				return nil
			})
			if _, err := os.Stat(conf); !os.IsNotExist(err) {
				t.Fatalf("conf written: %v", err)
			}
			if len(*calls) != 0 {
				t.Fatalf("calls = %v", *calls)
			}
		})
	}
}
