package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestVersionCommandMatchesTheFlag(t *testing.T) {
	previous := outputFlag
	outputFlag = "table"
	defer func() { outputFlag = previous }()

	root := rootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"version", "-o", "table"})
	if err := root.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out.String()); got != "orchard version "+Version {
		t.Fatalf("unexpected output %q", got)
	}
}

func TestVersionCommandSpeaksJSON(t *testing.T) {
	previous := outputFlag
	defer func() { outputFlag = previous }()

	printed := captureStdout(t, func() {
		if err := runCLI(t, "version", "-o", "json"); err != nil {
			t.Fatal(err)
		}
	})
	var got map[string]string
	if err := json.Unmarshal([]byte(printed), &got); err != nil {
		t.Fatalf("not JSON: %v (%q)", err, printed)
	}
	if got["version"] != Version {
		t.Fatalf("unexpected version %q", got["version"])
	}
}
