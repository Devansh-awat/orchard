package cmd

import "testing"

func TestReplForKnownLanguages(t *testing.T) {
	cases := map[string]string{
		"node":   "node",
		"Node":   "node",
		"bun":    "node",
		"python": "python3",
		"ruby":   "irb",
		"php":    "php -a",
		"elixir": "iex",
		"java":   "jshell",
	}
	for lang, want := range cases {
		if got := replFor(lang); got != want {
			t.Errorf("replFor(%q) = %q, want %q", lang, got, want)
		}
	}
}

func TestReplForCompiledLanguagesHasNoRepl(t *testing.T) {
	for _, lang := range []string{"go", "rust", "dotnet", "unknown", ""} {
		if got := replFor(lang); got != "" {
			t.Errorf("replFor(%q) = %q, want none", lang, got)
		}
	}
}
