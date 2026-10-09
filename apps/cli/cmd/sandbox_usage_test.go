package cmd

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSandboxUsagePairs(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	var raw map[string]any
	if err := json.Unmarshal([]byte(`{
		"runner": "kubernetes",
		"status": "running",
		"uptimeSeconds": 7500,
		"stopsAt": "2026-10-08T12:42:00Z",
		"lifetimeEndsAt": null,
		"machines": {"count": 2, "limit": 3},
		"kubernetes": {
			"cpu": {"usedMillicores": 420, "limitMillicores": 2000, "requestMillicores": null},
			"memory": {"usedBytes": 1610612736, "limitBytes": 4294967296},
			"disk": {"usedBytes": null, "capacityBytes": 10737418240}
		},
		"vercel": null
	}`), &raw); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, p := range sandboxUsagePairs(raw, now) {
		got[p[0]] = p[1]
	}
	want := map[string]string{
		"running for":   "2h 05m",
		"cpu":           "420m of 2 cores",
		"memory":        "1.5Gi of 4Gi",
		"disk":          "limit 10Gi",
		"stops if idle": "in 42m",
		"machines":      "2 of 3",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	for _, k := range []string{"cpu request", "max lifetime ends", "session ends"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s should be omitted when null", k)
		}
	}
}

func TestSandboxUsagePairsVercel(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	var raw map[string]any
	if err := json.Unmarshal([]byte(`{
		"runner": "vercel",
		"status": "running",
		"machines": {"count": 1, "limit": null},
		"kubernetes": null,
		"vercel": {
			"vcpus": 2, "memoryBytes": 4294967296, "activeCpuMs": 95000,
			"cpu": {"usedCores": 0.42, "totalCores": 2},
			"memory": {"usedBytes": 1610612736, "totalBytes": 4294967296},
			"networkEgressBytes": 1048576, "sessionExpiresAt": "2026-10-08T15:12:00Z",
			"disk": {"usedBytes": null, "capacityBytes": 68719476736}
		}
	}`), &raw); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, p := range sandboxUsagePairs(raw, now) {
		lines = append(lines, p[0]+"="+p[1])
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"cpu=0.42 of 2 cores", "memory=1.5Gi of 4Gi", "active cpu=1m35s", "network out=1Mi", "machines=1"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in\n%s", want, joined)
		}
	}
	for _, gone := range []string{"disk=", "session ends="} {
		if strings.Contains(joined, gone) {
			t.Errorf("%s should be omitted:\n%s", gone, joined)
		}
	}
}

func TestSandboxUsagePairsVercelBeforeLiveStats(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(`{
		"runner": "vercel",
		"status": "stopped",
		"kubernetes": null,
		"vercel": {"vcpus": 1, "memoryBytes": 2147483648, "disk": {"usedBytes": null, "capacityBytes": null}}
	}`), &raw); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, p := range sandboxUsagePairs(raw, time.Now()) {
		got[p[0]] = p[1]
	}
	if got["cpu"] != "limit 1 core" || got["memory"] != "limit 2Gi" {
		t.Errorf("allocation should show as limits, got cpu=%q memory=%q", got["cpu"], got["memory"])
	}
}
