package cli

import "testing"

func testRegistry() *Registry {
	noop := func(c *Context, args []string) error { return nil }
	return NewRegistry(
		&Command{Name: "update", Summary: "u", Root: true, Run: noop},
		&Command{Name: "config", Summary: "c", Root: true, Run: noop},
		&Command{Name: "status", Summary: "s", Run: noop},
		&Command{Name: "sync", Summary: "y", Root: true, Run: noop},
	)
}

func TestLookupKnownAndUnknown(t *testing.T) {
	r := testRegistry()
	if r.Lookup("config") == nil {
		t.Fatal("config should resolve")
	}
	if r.Lookup("nope") != nil {
		t.Fatal("unknown command should not resolve")
	}
}

func TestUsageListsEveryCommandAndItsRootNeeds(t *testing.T) {
	usage := testRegistry().Usage()
	for _, want := range []string{"update", "config", "status", "sync"} {
		if !contains(usage, want) {
			t.Fatalf("usage is missing %q:\n%s", want, usage)
		}
	}
	if !contains(usage, "update, config and sync need root") {
		t.Fatalf("usage should name the root commands:\n%s", usage)
	}
}

// The hyphenated aliases are how orchard-config keeps working, and a mistake
// here silently turns a command into a help screen.
func TestHyphenatedAliasSelectsTheCommand(t *testing.T) {
	r := testRegistry()
	for alias, want := range map[string]string{
		"orchard-update": "update",
		"orchard-config": "config",
		"orchard-status": "status",
	} {
		if sub := resolve(r, alias, nil); sub != want {
			t.Fatalf("%s should select %q, got %q", alias, want, sub)
		}
	}
}

// orchard-sync-commands is the shell bootstrap's name. Linked at this binary it
// must still sync rather than print help.
func TestBootstrapNameStillSyncs(t *testing.T) {
	if sub := resolve(testRegistry(), "orchard-sync-commands", nil); sub != "sync" {
		t.Fatalf("expected sync, got %q", sub)
	}
}

func TestPlainNameFallsBackToArgv(t *testing.T) {
	r := testRegistry()
	if sub := resolve(r, "orchardctl", []string{"status"}); sub != "status" {
		t.Fatalf("expected status, got %q", sub)
	}
	if sub := resolve(r, "orchardctl", nil); sub != "help" {
		t.Fatalf("bare invocation should be help, got %q", sub)
	}
}

// An unknown hyphenated name must not be mistaken for a command.
func TestUnknownAliasFallsBackToArgv(t *testing.T) {
	if sub := resolve(testRegistry(), "orchard-nonsense", []string{"status"}); sub != "status" {
		t.Fatalf("expected status, got %q", sub)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
