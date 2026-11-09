package commands

import (
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func zotEntries(t *testing.T, v *cli.Values) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, item := range v.List(egressPath) {
		if entry, ok := item.(map[string]any); ok {
			out = append(out, entry)
		}
	}
	return out
}

func TestUpdateLetsBuildsReachZotOnAnInstallThatNeverNamedIt(t *testing.T) {
	v, err := cli.ParseValues([]byte("builders:\n  enabled: true\n"))
	if err != nil {
		t.Fatal(err)
	}
	changes := retrofitZotEgress(v, "orchard", true)
	if len(changes) != 1 {
		t.Fatalf("changes = %v", changes)
	}
	got := zotEntries(t, v)
	if len(got) != 1 || got[0]["namespace"] != "orchard" {
		t.Fatalf("egress = %v", got)
	}
	labels, _ := got[0]["podLabels"].(map[string]any)
	if labels["app"] != "zot" {
		t.Fatalf("podLabels = %v", got[0]["podLabels"])
	}
	if again := retrofitZotEgress(v, "orchard", true); again != nil {
		t.Fatalf("second run must be a no-op, got %v", again)
	}
}

func TestUpdateLeavesRegistryEgressAloneWithoutZotOrWithAnEntryAlready(t *testing.T) {
	v, _ := cli.ParseValues([]byte("builders:\n  enabled: true\n"))
	if changes := retrofitZotEgress(v, "orchard", false); changes != nil || len(zotEntries(t, v)) != 0 {
		t.Fatal("no zot in the cluster means nothing to add")
	}
	custom := "builders:\n  registryEgress:\n    - namespace: orchard\n      podLabels: {app: my-registry}\n      ports: [{port: 5001}]\n"
	v, _ = cli.ParseValues([]byte(custom))
	if changes := retrofitZotEgress(v, "orchard", true); changes != nil {
		t.Fatalf("an existing entry for the namespace must win, got %v", changes)
	}
	labels, _ := zotEntries(t, v)[0]["podLabels"].(map[string]any)
	if labels["app"] != "my-registry" {
		t.Fatal("the operator's own entry was rewritten")
	}
	harbor := "builders:\n  registryEgress:\n    - namespace: harbor\n      podLabels: {component: core}\n"
	v, _ = cli.ParseValues([]byte(harbor))
	retrofitZotEgress(v, "orchard", true)
	if n := len(zotEntries(t, v)); n != 2 {
		t.Fatalf("zot is added next to other destinations, got %d entries", n)
	}
}
