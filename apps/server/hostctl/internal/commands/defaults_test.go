package commands

import (
	"errors"
	"strings"
	"testing"
)

const oldInstallerValues = `createNamespace: false
server:
  env:
    - {name: JWT_SECRET, value: jwt}
    - {name: SECRETS_ENCRYPTION_KEY, value: enc}
tenant:
  storageClass: local-path
postgres:
  storage:
    storageClass: local-path
metrics:
  enabled: false
  victoriametrics:
    retention: 7d
    storage:
      size: 5Gi
      storageClass: local-path
r2Proxy:
  enabled: false
`

func TestHostDefaultsTurnEverythingOnForAnOldInstall(t *testing.T) {
	values := load(t, oldInstallerValues)
	changes := applyHostDefaults(values, hostFacts{MemMB: 16000, DiskGB: 200, ObjectStorage: storedNone})
	if len(changes) == 0 {
		t.Fatal("expected changes")
	}
	for path, want := range map[string]any{
		"logs.victorialogs.storage.storageClass":   "local-path",
		"trivy.storage.storageClass":               "local-path",
		"trivy.enabled":                            true,
		"metrics.enabled":                          true,
		"objectStorage.local.enabled":              true,
		"objectStorage.local.storage.storageClass": "local-path",
		"objectStorage.local.storage.size":         "40Gi",
		"r2Proxy.enabled":                          true,
		"r2Proxy.replicas":                         1,
		"logs.maxDiskSpaceUsage":                   "16GiB",
		hostDefaultsPath:                           hostDefaultsVersion,
	} {
		if got := values.Get(path); got != want {
			t.Fatalf("%s: expected %#v, got %#v", path, want, got)
		}
	}
	if values.Get("logs.victorialogs.resources") != nil {
		t.Fatal("a big box keeps the chart's resources")
	}
	if got := values.EnvValue(serverEnvPath, "SECRETS_ENCRYPTION_KEY"); got != "enc" {
		t.Fatalf("server.env must survive, got %q", got)
	}
}

func TestHostDefaultsNeverClobberExplicitSettings(t *testing.T) {
	values := load(t, `server:
  env: []
postgres:
  storage:
    storageClass: local-path
logs:
  retention: 30d
  victorialogs:
    storage:
      storageClass: fast
trivy:
  enabled: false
objectStorage:
  local:
    enabled: false
`)
	applyHostDefaults(values, hostFacts{MemMB: 4000, DiskGB: 50, ObjectStorage: storedNone})
	for path, want := range map[string]any{
		"logs.retention":                         "30d",
		"logs.victorialogs.storage.storageClass": "fast",
		"trivy.enabled":                          false,
		"objectStorage.local.enabled":            false,
	} {
		if got := values.Get(path); got != want {
			t.Fatalf("%s: expected %#v kept, got %#v", path, want, got)
		}
	}
	if values.Get("r2Proxy.enabled") != nil {
		t.Fatal("r2Proxy is only turned on alongside local storage")
	}
	if values.Get("logs.victorialogs.resources") == nil || values.Get("trivy.maxConcurrentScans") != 1 {
		t.Fatal("a small box gets trimmed resources where nothing was set")
	}
}

func TestHostDefaultsRunOnce(t *testing.T) {
	values := load(t, oldInstallerValues)
	applyHostDefaults(values, hostFacts{ObjectStorage: storedNone})
	if err := values.Put("metrics.enabled", false); err != nil {
		t.Fatal(err)
	}
	if changes := applyHostDefaults(values, hostFacts{ObjectStorage: storedNone}); changes != nil {
		t.Fatalf("a second run should change nothing, got %v", changes)
	}
	if values.Get("metrics.enabled") != false {
		t.Fatal("turning metrics back off has to stick")
	}
}

func TestHostDefaultsSecondRoundNamesTheInstallerOperatorNamespace(t *testing.T) {
	values := load(t, "hostDefaults: 1\nmetrics:\n  enabled: false\nserver:\n  env:\n    - {name: JWT_SECRET, value: jwt}\n")
	changes := applyHostDefaults(values, hostFacts{ObjectStorage: storedNone})
	if len(changes) != 1 || !strings.Contains(changes[0], cnpgOperatorNamespaceEnv) {
		t.Fatalf("only the operator namespace should change, got %v", changes)
	}
	if got := values.EnvValue(serverEnvPath, cnpgOperatorNamespaceEnv); got != installerCnpgNamespace {
		t.Fatalf("expected %s, got %q", installerCnpgNamespace, got)
	}
	if values.Get("metrics.enabled") != false {
		t.Fatal("the first round must not run again")
	}

	custom := load(t, "hostDefaults: 1\nserver:\n  env:\n    - {name: CNPG_OPERATOR_NAMESPACE, value: mine}\n")
	applyHostDefaults(custom, hostFacts{})
	if got := custom.EnvValue(serverEnvPath, cnpgOperatorNamespaceEnv); got != "mine" {
		t.Fatalf("an explicit namespace has to stick, got %q", got)
	}
}

func TestHostDefaultsLeaveExistingObjectStorageAlone(t *testing.T) {
	cases := map[string]struct {
		body  string
		state storedState
	}{
		"env":            {oldInstallerValues + "  upstream: {}\n", storedPresent},
		"server env":     {strings.Replace(oldInstallerValues, "    - {name: JWT_SECRET, value: jwt}\n", "    - {name: JWT_SECRET, value: jwt}\n    - {name: R2_ENDPOINT, value: https://s3.example.com}\n", 1), storedNone},
		"proxy upstream": {oldInstallerValues + "  upstream:\n    endpoint: https://acct.r2.cloudflarestorage.com\n", storedNone},
		"unknown":        {oldInstallerValues, storedUnknown},
	}
	for name, tc := range cases {
		values := load(t, tc.body)
		changes := applyHostDefaults(values, hostFacts{ObjectStorage: tc.state})
		if values.Get("objectStorage.local.enabled") != nil {
			t.Fatalf("%s: local storage must stay off", name)
		}
		if values.Get("r2Proxy.enabled") != false {
			t.Fatalf("%s: r2Proxy must be left as it was", name)
		}
		if !strings.Contains(strings.Join(changes, "\n"), "object storage") {
			t.Fatalf("%s: the skip should be explained, got %v", name, changes)
		}
	}
}

func TestHostDefaultsSkipStorageClassWhenTheInstallNeverNamedOne(t *testing.T) {
	values := load(t, "server:\n  env: []\n")
	applyHostDefaults(values, hostFacts{ObjectStorage: storedNone})
	if values.Get("logs.victorialogs.storage.storageClass") != nil {
		t.Fatal("with no class to copy, the chart's cluster default is left in charge")
	}
}

func TestStoredObjectStorageState(t *testing.T) {
	for _, tc := range []struct {
		out  string
		err  error
		want storedState
	}{
		{"", nil, storedNone},
		{"\n", nil, storedNone},
		{`{"endpoint":"","bucketName":null}`, nil, storedNone},
		{`{"endpoint":"https://s3.example.com"}`, nil, storedPresent},
		{`not json`, nil, storedPresent},
		{"", errors.New("exec failed"), storedUnknown},
	} {
		if got := storedObjectStorageState(tc.out, tc.err); got != tc.want {
			t.Fatalf("%q/%v: expected %v, got %v", tc.out, tc.err, tc.want, got)
		}
	}
}

func TestHostDefaultsThirdRoundDropsTheInstallerLatestTags(t *testing.T) {
	const installed = "hostDefaults: 2\nimage:\n  registry: ghcr.io\n  repository: hackclub/orchard\n  pullPolicy: Always\nserver:\n  image:\n    tag: latest\n  env:\n    - {name: CNPG_OPERATOR_NAMESPACE, value: cnpg-system}\nfrontend:\n  image:\n    tag: latest\n"
	values := load(t, installed)
	changes := applyHostDefaults(values, hostFacts{ReleaseChart: true})
	if len(changes) != 2 || !strings.Contains(changes[0], "server.image.tag and frontend.image.tag removed") {
		t.Fatalf("expected one note for both tags and one for the pull policy, got %v", changes)
	}
	for _, path := range []string{"server.image", "frontend.image"} {
		if got := values.Get(path); got != nil {
			t.Fatalf("%s should follow the chart, got %#v", path, got)
		}
	}
	if values.Get("image.pullPolicy") != nil || values.Get(hostDefaultsPath) != hostDefaultsVersion {
		t.Fatal("without latest tags, Always gives way to the chart's pull policy")
	}

	if err := values.Put("server.image.tag", "latest"); err != nil {
		t.Fatal(err)
	}
	if changes := applyHostDefaults(values, hostFacts{ReleaseChart: true}); changes != nil {
		t.Fatalf("latest set after the round has to stick, got %v", changes)
	}

	for name, tc := range map[string]struct {
		body  string
		facts hostFacts
	}{
		"local chart": {installed, hostFacts{}},
		"mirror":      {strings.Replace(installed, "registry: ghcr.io", "registry: registry.example.com", 1), hostFacts{ReleaseChart: true}},
		"fork":        {strings.Replace(installed, "repository: hackclub/orchard", "repository: someone/orchard", 1), hostFacts{ReleaseChart: true}},
	} {
		values := load(t, tc.body)
		applyHostDefaults(values, tc.facts)
		if values.Get("server.image.tag") != "latest" || values.Get("frontend.image.tag") != "latest" {
			t.Fatalf("%s: a chart or registry without release versions keeps latest", name)
		}
		if values.Get("image.pullPolicy") != "Always" {
			t.Fatalf("%s: latest keeps pulling on every start", name)
		}
	}

	pinned := load(t, "hostDefaults: 2\nserver:\n  image:\n    tag: e2e\n  env:\n    - {name: CNPG_OPERATOR_NAMESPACE, value: cnpg-system}\n")
	if changes := applyHostDefaults(pinned, hostFacts{ReleaseChart: true}); changes != nil || pinned.Get("server.image.tag") != "e2e" {
		t.Fatalf("a tag other than latest is someone's choice, got %v", changes)
	}
}

func TestHostDefaultsFourthRoundDropsAlwaysForPinnedImages(t *testing.T) {
	const installed = "hostDefaults: 3\nimage:\n  registry: ghcr.io\n  repository: hackclub/orchard\n  pullPolicy: Always\nserver:\n  env:\n    - {name: CNPG_OPERATOR_NAMESPACE, value: cnpg-system}\n"
	values := load(t, installed)
	changes := applyHostDefaults(values, hostFacts{ReleaseChart: true})
	if len(changes) != 1 || !strings.Contains(changes[0], "image.pullPolicy removed") {
		t.Fatalf("expected one note for the pull policy, got %v", changes)
	}
	if values.Get("image.pullPolicy") != nil || values.Get("image.registry") != "ghcr.io" {
		t.Fatalf("only the pull policy goes, got %#v", values.Get("image"))
	}

	if err := values.Put("image.pullPolicy", "Always"); err != nil {
		t.Fatal(err)
	}
	if changes := applyHostDefaults(values, hostFacts{ReleaseChart: true}); changes != nil {
		t.Fatalf("Always set after the round has to stick, got %v", changes)
	}

	for name, body := range map[string]string{
		"server on latest": installed + "  image:\n    tag: latest\n",
		"mcp on latest":    installed + "mcp:\n  image:\n    tag: latest\n",
		"if not present":   strings.Replace(installed, "pullPolicy: Always", "pullPolicy: IfNotPresent", 1),
		"never":            strings.Replace(installed, "pullPolicy: Always", "pullPolicy: Never", 1),
	} {
		values := load(t, body)
		before := values.Get("image.pullPolicy")
		if changes := applyHostDefaults(values, hostFacts{ReleaseChart: true}); changes != nil || values.Get("image.pullPolicy") != before {
			t.Fatalf("%s: the pull policy has to stay %v, got %v and %v", name, before, values.Get("image.pullPolicy"), changes)
		}
	}
}

func TestReleaseChart(t *testing.T) {
	if !releaseChart("oci://ghcr.io/hackclub/orchard/charts/orchard") {
		t.Fatal("the published chart carries release versions")
	}
	if releaseChart(t.TempDir()) {
		t.Fatal("a chart directory from a checkout does not")
	}
}
