package commands

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Two lists name the same symlinks: this one, and the shell bootstrap's, which
// is what runs on the first sync of an upgrade. Drift is silent: the alias
// simply never appears on the host, and the command looks like it was never
// shipped.
func TestBootstrapLinksTheSameAliases(t *testing.T) {
	raw, err := os.ReadFile("../../../hostbin/orchard-sync-commands")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^ALIASES="([^"]*)"`).FindSubmatch(raw)
	if match == nil {
		t.Fatal("orchard-sync-commands no longer declares ALIASES")
	}

	shell := strings.Fields(string(match[1]))
	if len(shell) != len(Aliases) {
		t.Fatalf("bootstrap links %v, this binary links %v", shell, Aliases)
	}
	want := map[string]bool{}
	for _, name := range Aliases {
		want[name] = true
	}
	for _, name := range shell {
		if !want[name] {
			t.Fatalf("%s is linked by the bootstrap but not by orchardctl sync", name)
		}
	}
}

// The alias is how orchard-mcp reaches the mcp command at all.
func TestEveryAliasResolvesToACommand(t *testing.T) {
	for _, alias := range Aliases {
		name := strings.TrimPrefix(alias, "orchard-")
		found := false
		for _, c := range All() {
			if c.Name == name {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s maps to no command, so it would print help instead", alias)
		}
	}
}
