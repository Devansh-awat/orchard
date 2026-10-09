package cmd

import (
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
)

func writeFixture(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func claudeFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	writeFixture(t, home, map[string]string{
		".claude/CLAUDE.md":                        "# be good\n",
		".claude/agents/reviewer.md":               "---\nname: reviewer\n---\nreview things\n",
		".claude/agents/notes.txt":                 "not an agent",
		".claude/agents/bad name!.md":              "invalid name",
		".claude/agents/huge.md":                   strings.Repeat("a", claudeMaxFileBytes+1),
		".claude/commands/top.md":                  "top level command",
		".claude/commands/git/commit.md":           "commit it",
		".claude/commands/.secret/x.md":            "hidden",
		".claude/skills/pdf/SKILL.md":              "---\nname: pdf\n---\nread pdfs\n",
		".claude/skills/pdf/scripts/extract.py":    "print('hi')\n",
		".claude/skills/pdf/logo.png":              "\x89PNG\x00\x00binary",
		".claude/skills/pdf/.env":                  "SECRET=1",
		".claude/skills/pdf/node_modules/dep/a.js": "module.exports = 1",
		".claude/skills/notaskill/README.md":       "no SKILL.md here",
		".claude/settings.json": `{"mcpServers":{
			"github":{"command":"old"},
			"linear":{"type":"http","url":"https://mcp.linear.app/mcp","headers":{"Authorization":"Bearer lin_123"}}
		}}`,
		".claude.json": `{"numStartups":3,"mcpServers":{
			"github":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"ghp_secret","EMPTY":""}},
			"orchard":{"type":"http","url":"https://orchard.example/mcp"}
		},"projects":{"/x":{"mcpServers":{"nested":{"command":"ignored"}}}}}`,
	})
	if err := os.Symlink(filepath.Join(home, ".claude/CLAUDE.md"), filepath.Join(home, ".claude/skills/pdf/linked.md")); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(home, ".claude")
}

func allKinds(t *testing.T) map[string]bool {
	t.Helper()
	kinds, err := parseClaudeKinds(nil)
	if err != nil {
		t.Fatal(err)
	}
	return kinds
}

func foundByKey(scan *claudeScan) map[string]claudeFound {
	out := map[string]claudeFound{}
	for _, f := range scan.Found {
		out[f.Item.Kind+"/"+f.Item.Name] = f
	}
	return out
}

func TestScanClaudeMapsEveryKind(t *testing.T) {
	dir := claudeFixture(t)
	scan, err := scanClaude(dir, allKinds(t))
	if err != nil {
		t.Fatal(err)
	}

	order := []string{}
	for _, f := range scan.Found {
		order = append(order, f.Item.Kind+"/"+f.Item.Name)
	}
	want := []string{
		"instructions/CLAUDE.md",
		"agent/reviewer",
		"command/git:commit",
		"command/top",
		"skill/pdf",
		"mcp/github",
		"mcp/linear",
	}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("found = %v\nwant    %v", order, want)
	}

	got := foundByKey(scan)
	if f := got["instructions/CLAUDE.md"]; !reflect.DeepEqual(f.Item.Files, map[string]string{"CLAUDE.md": "# be good\n"}) {
		t.Errorf("instructions files = %v", f.Item.Files)
	}
	if f := got["agent/reviewer"]; !reflect.DeepEqual(slices.Sorted(maps.Keys(f.Item.Files)), []string{"reviewer.md"}) {
		t.Errorf("agent files = %v", f.Item.Files)
	}
	if f := got["command/git:commit"]; f.Item.Files["git:commit.md"] != "commit it" || len(f.Item.Files) != 1 {
		t.Errorf("nested command files = %v", f.Item.Files)
	}

	skill := got["skill/pdf"]
	if keys := slices.Sorted(maps.Keys(skill.Item.Files)); !reflect.DeepEqual(keys, []string{"SKILL.md", "scripts/extract.py"}) {
		t.Errorf("skill files = %v, want SKILL.md + scripts/extract.py only", keys)
	}
	if skill.Size != len("---\nname: pdf\n---\nread pdfs\n")+len("print('hi')\n") {
		t.Errorf("skill size = %d", skill.Size)
	}

	gh := got["mcp/github"]
	if gh.Item.MCP["command"] != "npx" {
		t.Errorf("~/.claude.json should win over settings.json, got command %v", gh.Item.MCP["command"])
	}
	if gh.Item.Files != nil {
		t.Errorf("mcp items carry no files, got %v", gh.Item.Files)
	}
	if !reflect.DeepEqual(gh.Secrets, []string{"GITHUB_TOKEN"}) {
		t.Errorf("github secrets = %v, want only the key with a value", gh.Secrets)
	}
	if lin := got["mcp/linear"]; !reflect.DeepEqual(lin.Secrets, []string{"Authorization"}) {
		t.Errorf("linear secrets = %v", lin.Secrets)
	}
	if _, ok := got["mcp/orchard"]; ok {
		t.Error("the reserved orchard mcp server must never be imported")
	}
	if _, ok := got["mcp/nested"]; ok {
		t.Error("per-project mcpServers must not be imported")
	}

	notes := strings.Join(scan.Skipped, "\n")
	for _, want := range []string{`agent "bad name!"`, "agent huge: over the 256 KiB file limit", "mcp orchard", "skill pdf", "logo.png"} {
		if !strings.Contains(notes, want) {
			t.Errorf("skipped notes missing %q:\n%s", want, notes)
		}
	}
	if strings.Contains(notes, "node_modules") || strings.Contains(notes, ".env") || strings.Contains(notes, "linked.md") {
		t.Errorf("dotfiles, node_modules and symlinks should be skipped silently:\n%s", notes)
	}
}

func TestScanClaudeOnly(t *testing.T) {
	dir := claudeFixture(t)
	kinds, err := parseClaudeKinds([]string{"skill", " MCP "})
	if err != nil {
		t.Fatal(err)
	}
	scan, err := scanClaude(dir, kinds)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range scan.Found {
		if f.Item.Kind != "skill" && f.Item.Kind != "mcp" {
			t.Errorf("--only skill,mcp let through %s/%s", f.Item.Kind, f.Item.Name)
		}
	}
	if _, err := parseClaudeKinds([]string{"agents"}); !errors.As(err, new(*exitcode.UsageError)) {
		t.Errorf("unknown kind should be a usage error, got %v", err)
	}
}

func TestScanClaudeItemLimit(t *testing.T) {
	home := t.TempDir()
	files := map[string]string{".claude/skills/big/SKILL.md": "big"}
	for i := range 5 {
		files[".claude/skills/big/part"+string(rune('a'+i))+".md"] = strings.Repeat("x", claudeMaxFileBytes-10)
	}
	writeFixture(t, home, files)
	scan, err := scanClaude(filepath.Join(home, ".claude"), allKinds(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Found) != 0 {
		t.Errorf("a skill over 1 MiB should be skipped, found %d", len(scan.Found))
	}
	if !strings.Contains(strings.Join(scan.Skipped, "\n"), "1 MiB item limit") {
		t.Errorf("missing item limit note: %v", scan.Skipped)
	}
}

func TestScanClaudeMissingDir(t *testing.T) {
	if _, err := scanClaude(filepath.Join(t.TempDir(), "nope"), allKinds(t)); err == nil {
		t.Fatal("expected an error for a missing config dir")
	}
}

func runContext(t *testing.T, args ...string) error {
	t.Helper()
	prevYes, prevOut := yesFlag, outputFlag
	t.Cleanup(func() { yesFlag, outputFlag = prevYes, prevOut })
	origStdout := os.Stdout
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = devnull
	t.Cleanup(func() { os.Stdout = origStdout; devnull.Close() })
	root := rootCmd()
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.ExecuteContext(t.Context())
}

func TestContextImportPostsItems(t *testing.T) {
	dir := claudeFixture(t)
	srv, calls := githubTestServer(t, map[string]string{
		"POST /apiv1/me/context/import": `{"imported":7,"items":[]}`,
	})
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	if err := runContext(t, "claude", "import", "--dir", dir, "--yes"); err != nil {
		t.Fatalf("context import: %v", err)
	}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, []string{"POST /apiv1/me/context/import"}) {
		t.Fatalf("calls = %v", got)
	}
	items, _ := (*calls)[0].body["items"].([]any)
	if len(items) != 7 {
		t.Fatalf("posted %d items, want 7", len(items))
	}
	for _, raw := range items {
		it := raw.(map[string]any)
		switch it["kind"] {
		case "mcp":
			if _, ok := it["files"]; ok {
				t.Errorf("mcp item %v should not send files", it["name"])
			}
			if _, ok := it["mcp"].(map[string]any); !ok {
				t.Errorf("mcp item %v is missing its server object", it["name"])
			}
		default:
			if _, ok := it["mcp"]; ok {
				t.Errorf("%v item %v should not send mcp", it["kind"], it["name"])
			}
			if _, ok := it["files"].(map[string]any); !ok {
				t.Errorf("%v item %v is missing files", it["kind"], it["name"])
			}
		}
	}
}

func TestContextImportDryRunSkipsAPI(t *testing.T) {
	dir := claudeFixture(t)
	srv, calls := githubTestServer(t, map[string]string{})
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	if err := runContext(t, "claude", "import", "--dir", dir, "--dry-run"); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if len(*calls) != 0 {
		t.Errorf("dry run hit the API: %v", githubCallSigs(*calls))
	}
}

func TestContextImportNonTTYNeedsYes(t *testing.T) {
	dir := claudeFixture(t)
	srv, calls := githubTestServer(t, map[string]string{})
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	err := runContext(t, "claude", "import", "--dir", dir)
	if !errors.Is(err, output.ErrPromptRefused) {
		t.Fatalf("want ErrPromptRefused without --yes off a TTY, got %v", err)
	}
	if len(*calls) != 0 {
		t.Errorf("refused import hit the API: %v", githubCallSigs(*calls))
	}
}

func TestContextRemoveResolvesThenDeletes(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/me/context":         `{"items":[{"id":"c1","kind":"agent","name":"reviewer","enabled":true,"sizeBytes":10,"updatedAt":"2026-10-09T00:00:00Z"},{"id":"c2","kind":"command","name":"git:commit","enabled":true,"sizeBytes":9,"updatedAt":"2026-10-09T00:00:00Z"}]}`,
		"DELETE /apiv1/me/context/c2":   `{"success":true}`,
		"DELETE /apiv1/me/context/c1":   `{"success":true}`,
		"POST /apiv1/me/context/import": `{}`,
	})
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	if err := runContext(t, "claude", "remove", "command/git/commit", "--yes"); err != nil {
		t.Fatalf("context remove: %v", err)
	}
	want := []string{"GET /apiv1/me/context", "DELETE /apiv1/me/context/c2"}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
	if err := runContext(t, "claude", "remove", "agent/nobody", "--yes"); err == nil {
		t.Error("removing an unknown item should fail")
	}
	if err := runContext(t, "claude", "remove", "reviewer", "--yes"); !errors.As(err, new(*exitcode.UsageError)) {
		t.Errorf("a bare name should be a usage error, got %v", err)
	}
}

func TestContextList(t *testing.T) {
	srv, calls := githubTestServer(t, map[string]string{
		"GET /apiv1/me/context": `{"items":[{"id":"c1","kind":"agent","name":"reviewer","enabled":true,"sizeBytes":10,"updatedAt":"2026-10-09T00:00:00Z"}]}`,
	})
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	if err := runContext(t, "claude", "list"); err != nil {
		t.Fatalf("context list: %v", err)
	}
	if got := githubCallSigs(*calls); !reflect.DeepEqual(got, []string{"GET /apiv1/me/context"}) {
		t.Errorf("calls = %v", got)
	}
}
