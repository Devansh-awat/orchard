package commands

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
)

func installerFunctions(t *testing.T, names ...string) string {
	t.Helper()
	raw, err := os.ReadFile("../../../../../install/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	var functions strings.Builder
	for _, name := range names {
		body := regexp.MustCompile(`(?ms)^` + name + `\(\) \{.*?^\}`).Find(raw)
		if body == nil {
			t.Fatalf("install.sh no longer defines %s", name)
		}
		functions.Write(body)
		functions.WriteString("\n")
	}
	return functions.String()
}

func TestInstallSummaryExplainsTheSandboxes(t *testing.T) {
	functions := installerFunctions(t, "sandboxes_on", "sandbox_notice")
	run := func(enabled string) string {
		script := functions + `note() { echo "$*"; }
yq() { echo ` + enabled + `; }
sandbox_notice
`
		out, err := exec.Command("bash", "-c", script).CombinedOutput()
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		return string(out)
	}
	if out := run("false"); !strings.Contains(out, "not safe for tenants") {
		t.Fatalf("the summary should warn while the sandboxes are off:\n%s", out)
	}
	if out := run("true"); out != "" {
		t.Fatalf("nothing to say once the sandboxes are on:\n%s", out)
	}
}
