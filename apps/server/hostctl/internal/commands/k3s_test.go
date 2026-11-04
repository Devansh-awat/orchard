package commands

import (
	"os"
	"path/filepath"
	"testing"
)

const channelsFixture = `{"data":[
  {"name":"stable","latest":"v1.36.5+k3s1"},
  {"name":"latest","latest":"v1.37.1+k3s1"},
  {"name":"testing","latest":"v1.38.0-rc1+k3s1"},
  {"name":"v1.31","latest":"v1.31.14+k3s1"},
  {"name":"v1.32","latest":"v1.32.13+k3s1"},
  {"name":"v1.33","latest":"v1.33.13+k3s2"},
  {"name":"v1.34","latest":"v1.34.12+k3s1"},
  {"name":"v1.35","latest":"v1.35.9+k3s1"},
  {"name":"v1.36","latest":"v1.36.5+k3s1"},
  {"name":"v1.37","latest":"v1.37.1+k3s1"}
]}`

func version(t *testing.T, raw string) k3sVersion {
	t.Helper()
	v, err := parseK3sVersion(raw)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func fixtureChannels(t *testing.T) k3sChannels {
	t.Helper()
	channels, err := parseK3sChannels([]byte(channelsFixture))
	if err != nil {
		t.Fatal(err)
	}
	return channels
}

func TestParseK3sVersionRejectsAnythingElse(t *testing.T) {
	for _, raw := range []string{"", "v1.31", "1.31.5+k3s1", "v1.38.0-rc1+k3s1", "v1.31.5+k3s1; rm -rf /"} {
		if _, err := parseK3sVersion(raw); err == nil {
			t.Errorf("%q parsed", raw)
		}
	}
}

func TestNewerThanComparesNumbersNotText(t *testing.T) {
	if !version(t, "v1.31.14+k3s1").newerThan(version(t, "v1.31.5+k3s1")) {
		t.Error("1.31.14 should be newer than 1.31.5")
	}
	if !version(t, "v1.33.13+k3s2").newerThan(version(t, "v1.33.13+k3s1")) {
		t.Error("a later k3s build should be newer")
	}
	if version(t, "v1.31.5+k3s1").newerThan(version(t, "v1.31.5+k3s1")) {
		t.Error("a version isn't newer than itself")
	}
}

func TestChannelsSkipPrereleasesAndNeedStable(t *testing.T) {
	channels := fixtureChannels(t)
	if _, ok := channels["testing"]; ok {
		t.Error("a release candidate should not be usable")
	}
	if _, err := parseK3sChannels([]byte(`{"data":[{"name":"v1.31","latest":"v1.31.14+k3s1"}]}`)); err == nil {
		t.Error("channels with no stable should fail")
	}
}

func TestPatchTargetStaysInTheMinorVersion(t *testing.T) {
	channels := fixtureChannels(t)
	target, ok := k3sPatchTarget(version(t, "v1.31.5+k3s1"), channels)
	if !ok || target.raw != "v1.31.14+k3s1" {
		t.Fatalf("got %v %v", target, ok)
	}
	if _, ok := k3sPatchTarget(version(t, "v1.36.5+k3s1"), channels); ok {
		t.Error("already on the latest patch")
	}
	if _, ok := k3sPatchTarget(version(t, "v1.20.1+k3s1"), channels); ok {
		t.Error("no channel for that minor version")
	}
}

func TestUpgradePathVisitsEveryMinorVersionUpToStable(t *testing.T) {
	path, err := k3sUpgradePath(version(t, "v1.31.5+k3s1"), fixtureChannels(t))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"v1.31.14+k3s1", "v1.32.13+k3s1", "v1.33.13+k3s2", "v1.34.12+k3s1", "v1.35.9+k3s1", "v1.36.5+k3s1"}
	if len(path) != len(want) {
		t.Fatalf("got %v", path)
	}
	for i := range want {
		if path[i].raw != want[i] {
			t.Errorf("step %d: got %s, want %s", i, path[i].raw, want[i])
		}
	}
}

func TestUpgradePathStopsWhenAMinorVersionIsMissing(t *testing.T) {
	channels := fixtureChannels(t)
	delete(channels, "v1.33")
	if _, err := k3sUpgradePath(version(t, "v1.31.5+k3s1"), channels); err == nil {
		t.Error("skipping a minor version should fail")
	}
}

func TestUpgradePathIsEmptyAtOrPastStable(t *testing.T) {
	for _, raw := range []string{"v1.36.5+k3s1", "v1.37.1+k3s1"} {
		path, err := k3sUpgradePath(version(t, raw), fixtureChannels(t))
		if err != nil || len(path) != 0 {
			t.Errorf("%s: got %v %v", raw, path, err)
		}
	}
}

func TestOutOfSupportIsThreeMinorVersionsFromTheNewest(t *testing.T) {
	channels := fixtureChannels(t)
	if !k3sOutOfSupport(version(t, "v1.34.12+k3s1"), channels) {
		t.Error("1.34 is behind 1.37 by three")
	}
	if k3sOutOfSupport(version(t, "v1.35.9+k3s1"), channels) {
		t.Error("1.35 is still supported")
	}
}

func TestChecksumFindsTheExactAsset(t *testing.T) {
	sums := "aaa  k3s-airgap-images-amd64.tar\nbbb  k3s\nccc  *k3s-arm64\n"
	if got, err := k3sChecksum(sums, "k3s"); err != nil || got != "bbb" {
		t.Errorf("got %q %v", got, err)
	}
	if got, err := k3sChecksum(sums, "k3s-arm64"); err != nil || got != "ccc" {
		t.Errorf("got %q %v", got, err)
	}
	if _, err := k3sChecksum(sums, "k3s-armhf"); err == nil {
		t.Error("a missing checksum should fail")
	}
}

func TestAssetsCoverEveryArchitectureK3sBuilds(t *testing.T) {
	for arch, want := range map[string]string{"amd64": "k3s", "arm64": "k3s-arm64", "arm": "k3s-armhf"} {
		if got, _, err := k3sAssets(arch); err != nil || got != want {
			t.Errorf("%s: got %q %v", arch, got, err)
		}
	}
	if _, _, err := k3sAssets("riscv64"); err == nil {
		t.Error("an unknown architecture should fail")
	}
}

func TestNodesSplitControlPlaneFromWorkers(t *testing.T) {
	nodes, err := parseK3sNodes([]byte(`{"items":[
	  {"metadata":{"name":"a","labels":{"node-role.kubernetes.io/control-plane":"true"}},
	   "status":{"nodeInfo":{"kubeletVersion":"v1.31.14+k3s1"},"conditions":[{"type":"Ready","status":"True"}]}},
	  {"metadata":{"name":"b","labels":{}},
	   "status":{"nodeInfo":{"kubeletVersion":"v1.31.5+k3s1"},"conditions":[{"type":"Ready","status":"False"}]}},
	  {"metadata":{"name":"c","labels":{}},
	   "status":{"nodeInfo":{"kubeletVersion":"v1.31.14+k3s1"},"conditions":[{"type":"Ready","status":"True"}]}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	planes := k3sControlPlanes(nodes)
	if len(planes) != 1 || planes[0].name != "a" || !planes[0].ready {
		t.Errorf("got %+v", planes)
	}
	behind := k3sWorkersBehind(nodes, "v1.31.14+k3s1")
	if len(behind) != 1 || behind[0] != "b (v1.31.5+k3s1)" {
		t.Errorf("got %v", behind)
	}
}

func TestDatabaseCopyRestoresWhatWasThere(t *testing.T) {
	root := t.TempDir()
	live := filepath.Join(root, "db")
	backup := filepath.Join(root, "db.previous")
	if err := os.MkdirAll(filepath.Join(live, "etcd"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(live, "state.db"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(live, "state.db-wal"), []byte("old-wal"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyK3sDatabase(live, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(live, "state.db"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(live, "state.db-shm"), []byte("new-shm"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(live, "state.db-wal")); err != nil {
		t.Fatal(err)
	}
	if err := restoreK3sDatabase(backup, live); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"state.db": "old", "state.db-wal": "old-wal"} {
		got, err := os.ReadFile(filepath.Join(live, name))
		if err != nil || string(got) != want {
			t.Errorf("%s: got %q %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(live, "state.db-shm")); !os.IsNotExist(err) {
		t.Error("a file the backup doesn't have should be gone")
	}
	if _, err := os.Stat(filepath.Join(live, "etcd")); err != nil {
		t.Error("a directory should be left alone")
	}
}
