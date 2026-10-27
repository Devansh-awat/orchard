package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// commandsRoot returns the real tree; root.go registers the introspection
// commands, so only add them if a stripped-down root ever drops them.
func commandsRoot() *cobra.Command {
	root := rootCmd()
	for _, name := range []string{"commands", "exit-codes"} {
		if _, _, err := root.Find([]string{name}); err != nil {
			switch name {
			case "commands":
				root.AddCommand(commandsCmd())
			case "exit-codes":
				root.AddCommand(exitCodesCmd())
			}
		}
	}
	return root
}

// captureStdout runs fn with os.Stdout redirected to a pipe, returning what
// it printed (output.JSON/KV write to os.Stdout directly, not cobra's out).
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	fn()
	w.Close()
	return <-done
}

func runForStdout(t *testing.T, args ...string) string {
	t.Helper()
	root := commandsRoot()
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return captureStdout(t, func() {
		if err := root.ExecuteContext(context.Background()); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	})
}

func decodeCommandDump(t *testing.T, out string) map[string]commandInfo {
	t.Helper()
	var infos []commandInfo
	if err := json.Unmarshal([]byte(out), &infos); err != nil {
		t.Fatalf("commands -o json is not valid JSON: %v\n%s", err, out)
	}
	byName := map[string]commandInfo{}
	for _, info := range infos {
		if info.Name == "" {
			t.Errorf("entry with empty name: %+v", info)
		}
		if _, dup := byName[info.Name]; dup {
			t.Errorf("duplicate command name %q in dump", info.Name)
		}
		byName[info.Name] = info
	}
	return byName
}

func findFlag(t *testing.T, info commandInfo, name string) commandFlag {
	t.Helper()
	for _, f := range info.Flags {
		if f.Name == name {
			return f
		}
	}
	t.Fatalf("command %q has no flag %q (flags: %+v)", info.Name, name, info.Flags)
	return commandFlag{}
}

func TestCommandsJSONDump(t *testing.T) {
	byName := decodeCommandDump(t, runForStdout(t, "commands", "-o", "json"))
	if len(byName) < 100 {
		t.Fatalf("dump has %d commands; expected the full tree", len(byName))
	}

	for _, leaf := range []string{
		"deploy env set",
		"db backup create",
		"domain protection set",
		"service port public enable",
		"job-run logs",
		"commands",
		"exit-codes",
	} {
		if _, ok := byName[leaf]; !ok {
			t.Errorf("dump is missing %q", leaf)
		}
	}

	envSet := byName["deploy env set"]
	if !strings.HasPrefix(envSet.Use, "set") {
		t.Errorf("deploy env set use = %q, want it to start with 'set'", envSet.Use)
	}
	if f := findFlag(t, envSet, "secret"); f.Type != "bool" || f.Default != "false" || f.Persistent {
		t.Errorf("deploy env set --secret = %+v, want local bool defaulting to false", f)
	}
	if f := findFlag(t, envSet, "file"); f.Type != "string" || f.Default != "" {
		t.Errorf("deploy env set --file = %+v, want string defaulting to empty", f)
	}
	if f := findFlag(t, envSet, "output"); !f.Persistent || f.Shorthand != "o" {
		t.Errorf("deploy env set --output = %+v, want inherited persistent flag with shorthand o", f)
	}

	logs := byName["deploy logs"]
	if f := findFlag(t, logs, "tail"); f.Type != "int" || f.Default != "100" {
		t.Errorf("deploy logs --tail = %+v, want int defaulting to 100", f)
	}
	if f := findFlag(t, logs, "follow"); f.Shorthand != "f" || f.Persistent {
		t.Errorf("deploy logs --follow = %+v, want local flag with shorthand f", f)
	}

	deploy := byName["deploy"]
	if len(deploy.Aliases) == 0 {
		t.Errorf("deploy aliases = %v, want deployment/deployments", deploy.Aliases)
	}
	if !byName["exit-codes"].Hidden {
		t.Error("exit-codes should be marked hidden in the dump")
	}
}

func TestCommandsTableTree(t *testing.T) {
	out := runForStdout(t, "commands", "-o", "table")
	if !strings.Contains(out, "\ndeploy") {
		t.Errorf("tree output missing top-level deploy:\n%s", out)
	}
	if !strings.Contains(out, "\n    set") {
		t.Errorf("tree output missing a depth-2 leaf like deploy env set:\n%s", out)
	}
	if strings.Contains(out, "exit-codes") {
		t.Errorf("hidden exit-codes should not appear in the table tree:\n%s", out)
	}
}

func TestExitCodesRendersAllCodes(t *testing.T) {
	out := runForStdout(t, "exit-codes", "-o", "json")
	var docs []exitCodeDoc
	if err := json.Unmarshal([]byte(out), &docs); err != nil {
		t.Fatalf("exit-codes -o json is not valid JSON: %v\n%s", err, out)
	}
	if len(docs) != 12 {
		t.Fatalf("exit-codes lists %d codes, want 12", len(docs))
	}
	want := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 130}
	for i, doc := range docs {
		if doc.Code != want[i] {
			t.Errorf("code[%d] = %d, want %d", i, doc.Code, want[i])
		}
		if doc.Name == "" || doc.Description == "" {
			t.Errorf("code %d is missing a name or description: %+v", doc.Code, doc)
		}
	}

	table := runForStdout(t, "exit-codes", "-o", "table")
	for _, needle := range []string{"130", "rate-limited", "not-found", "interrupted", "deploy-failed", "deploy-crashing"} {
		if !strings.Contains(table, needle) {
			t.Errorf("exit-codes table output missing %q:\n%s", needle, table)
		}
	}
}

func TestHelpExitCodesRendersTopic(t *testing.T) {
	root := commandsRoot()
	var buf bytes.Buffer
	root.SetOut(&buf)
	root.SetErr(&buf)
	root.SetArgs([]string{"help", "exit-codes"})
	if err := root.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("help exit-codes: %v", err)
	}
	out := buf.String()
	for _, needle := range []string{"130", "interrupted", "rate-limited"} {
		if !strings.Contains(out, needle) {
			t.Errorf("help exit-codes output missing %q:\n%s", needle, out)
		}
	}
}
