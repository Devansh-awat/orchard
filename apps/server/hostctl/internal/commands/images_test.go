package commands

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func mustTag(t *testing.T, raw string) imageTag {
	t.Helper()
	tag, ok := parseImageTag(raw)
	if !ok {
		t.Fatalf("%q didn't parse", raw)
	}
	return tag
}

func TestParseImageTagKeepsPrefixAndSuffix(t *testing.T) {
	tag := mustTag(t, "v1.155.0")
	if tag.prefix != "v" || tag.major != 1 || tag.minor != 155 || tag.suffix != "" {
		t.Errorf("got %+v", tag)
	}
	tag = mustTag(t, "7.4.11-alpine")
	if tag.prefix != "" || tag.patch != 11 || tag.suffix != "-alpine" {
		t.Errorf("got %+v", tag)
	}
	for _, raw := range []string{"latest", "7", "7.4", "17-alpine", "20260227", "sha-abc"} {
		if _, ok := parseImageTag(raw); ok {
			t.Errorf("%q parsed", raw)
		}
	}
}

func raws(candidates []candidate) []string {
	out := make([]string, len(candidates))
	for i, c := range candidates {
		out[i] = c.tag.raw
	}
	return out
}

func TestCandidatesStayInTheSameMajorAndFlavour(t *testing.T) {
	tags := []string{"v1.154.1", "v1.160.2", "v1.155.0", "v2.0.0", "1.999.0", "v1.200.0-rc1", "latest", "v1.150.0"}
	candidates, ahead := imageCandidates(mustTag(t, "v1.154.1"), tags, false, false, false, nil, "repo")
	if got := strings.Join(raws(candidates), " "); got != "v1.155.0 v1.160.2" {
		t.Errorf("candidates %s", got)
	}
	if ahead == nil || ahead.raw != "v2.0.0" {
		t.Errorf("ahead %v", ahead)
	}
}

func TestCandidatesTreatAZeroMinorAsAMajor(t *testing.T) {
	tags := []string{"0.61.0", "0.61.1", "0.61.4", "0.62.0", "0.63.1", "1.0.0"}
	candidates, ahead := imageCandidates(mustTag(t, "0.61.0"), tags, false, false, false, nil, "vector")
	if got := strings.Join(raws(candidates), " "); got != "0.61.1 0.61.4" {
		t.Errorf("candidates %s", got)
	}
	if ahead == nil || ahead.raw != "1.0.0" {
		t.Errorf("ahead %v", ahead)
	}
	candidates, _ = imageCandidates(mustTag(t, "1.4.0"), []string{"1.4.1", "1.5.0", "2.0.0"}, false, false, false, nil, "x")
	if got := strings.Join(raws(candidates), " "); got != "1.4.1 1.5.0" {
		t.Errorf("a minor version above 1.0 should be eligible: %s", got)
	}
}

func TestCandidatesKeepTheAlpineFlavour(t *testing.T) {
	tags := []string{"7.4.11-alpine", "7.4.12-alpine", "7.4.13", "7.4.14-bookworm", "7.6.0-alpine", "8.0.0-alpine"}
	candidates, ahead := imageCandidates(mustTag(t, "7.4.11-alpine"), tags, true, false, false, nil, "redis")
	if got := strings.Join(raws(candidates), " "); got != "7.4.12-alpine" {
		t.Errorf("patch-only candidates %s", got)
	}
	if ahead == nil || ahead.raw != "8.0.0-alpine" {
		t.Errorf("ahead %v", ahead)
	}
}

func TestCandidatesSkipAHeldVersion(t *testing.T) {
	held := map[string]bool{"repo:v1.156.0": true}
	candidates, _ := imageCandidates(mustTag(t, "v1.155.0"), []string{"v1.155.0", "v1.156.0", "v1.157.0"}, false, false, false, held, "repo")
	if got := strings.Join(raws(candidates), " "); got != "v1.157.0" {
		t.Errorf("candidates %s", got)
	}
}

func TestSplitImage(t *testing.T) {
	repo, tag, ok := splitImage("registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0")
	if !ok || repo != "registry.k8s.io/kube-state-metrics/kube-state-metrics" || tag != "v2.20.0" {
		t.Errorf("got %q %q %v", repo, tag, ok)
	}
	if _, _, ok := splitImage("localhost:5000/app"); ok {
		t.Error("a registry port isn't a tag")
	}
	if _, _, ok := splitImage("redis@sha256:abc"); ok {
		t.Error("a digest has no tag to move")
	}
	repo, tag, ok = splitImage("localhost:5000/redis:8.10.3-alpine@sha256:abc")
	if !ok || repo != "localhost:5000/redis" || tag != "8.10.3-alpine" {
		t.Errorf("a pinned tag: got %q %q %v", repo, tag, ok)
	}
}

func TestFloatingCandidatesCanCrossACalendarYear(t *testing.T) {
	tags := []string{"2026.11.0", "2026.12.1", "2027.1.0", "2027.1.1", "latest"}
	held := map[string]bool{"cf:2027.1.1": true}
	candidates, ahead := imageCandidates(mustTag(t, "2026.11.0"), tags, false, true, false, held, "cf")
	if got := strings.Join(raws(candidates), " "); got != "2026.12.1 2027.1.0" || ahead != nil {
		t.Errorf("calendar candidates %s, ahead %v", got, ahead)
	}
	candidates, ahead = imageCandidates(mustTag(t, "v2.1.20"), []string{"v2.1.23", "v3.0.0"}, false, false, false, nil, "zot")
	if got := strings.Join(raws(candidates), " "); got != "v2.1.23" || ahead == nil || ahead.raw != "v3.0.0" {
		t.Errorf("semver candidates %s ahead %v", got, ahead)
	}
}

func TestRegistryRef(t *testing.T) {
	cases := map[string][2]string{
		"redis":                        {"registry-1.docker.io", "library/redis"},
		"prom/node-exporter":           {"registry-1.docker.io", "prom/node-exporter"},
		"docker.io/traefik":            {"registry-1.docker.io", "library/traefik"},
		"ghcr.io/aquasecurity/trivy":   {"ghcr.io", "aquasecurity/trivy"},
		"registry.k8s.io/ksm/ksm":      {"registry.k8s.io", "ksm/ksm"},
		"localhost:5000/project/image": {"localhost:5000", "project/image"},
	}
	for repo, want := range cases {
		host, path := registryRef(repo)
		if host != want[0] || path != want[1] {
			t.Errorf("%s: got %s %s", repo, host, path)
		}
	}
}

func TestTokenURLFromChallenge(t *testing.T) {
	got, err := tokenURLFromChallenge(`Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/redis:pull"`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, "https://auth.docker.io/token?") || !strings.Contains(got, "service=registry.docker.io") || !strings.Contains(got, "repository%3Alibrary%2Fredis%3Apull") {
		t.Errorf("got %s", got)
	}
	if _, err := tokenURLFromChallenge(`Basic realm="x"`); err == nil {
		t.Error("basic auth should fail")
	}
}

func TestNextPage(t *testing.T) {
	if got := nextPage("ghcr.io", `</v2/a/tags/list?last=x&n=1000>; rel="next"`); got != "https://ghcr.io/v2/a/tags/list?last=x&n=1000" {
		t.Errorf("got %s", got)
	}
	if got := nextPage("ghcr.io", ""); got != "" {
		t.Errorf("got %s", got)
	}
}

func values(t *testing.T, raw string) *cli.Values {
	t.Helper()
	v, err := cli.ParseValues([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func lookups(tags func(string) ([]string, error), digest func(string, string) (string, error)) registryLookups {
	return registryLookups{tags: tags, digest: digest, published: func(string, string) (time.Time, error) {
		return time.Time{}, errors.New("no dates in this test")
	}}
}

func openGate() *updateGate {
	return &updateGate{now: func() time.Time { return fixedNow }}
}

func TestReportLeavesAnImageTheUserSet(t *testing.T) {
	report := reportImage(bundledImage{path: "redis.image", patchOnly: true},
		values(t, "redis: {image: 'redis:8.10.3-alpine'}"),
		values(t, "redis: {image: 'my.registry/redis:6.0.0'}"),
		values(t, "{}"),
		lookups(func(string) ([]string, error) { t.Fatal("no registry call for a pinned image"); return nil, nil }, noDigest(t)),
		nil, openGate())
	if !report.pinned || report.chosen != "my.registry/redis:6.0.0" {
		t.Errorf("got %+v", report)
	}
}

func TestReportNeverGoesBelowTheChartOrTheLastVersion(t *testing.T) {
	entry := bundledImage{path: "logs.vector.image"}
	chart := values(t, "logs: {vector: {image: 'timberio/vector:0.61.0-distroless-libc'}}")
	tags := func(string) ([]string, error) {
		return []string{"0.60.0-distroless-libc", "0.61.0-distroless-libc", "0.61.2-distroless-libc", "0.61.3-distroless-libc", "0.62.0-distroless-libc"}, nil
	}
	report := reportImage(entry, chart, values(t, "{}"), values(t, "{}"), lookups(tags, digestOf), nil, openGate())
	if report.running != "timberio/vector:0.61.0-distroless-libc" || report.chosen != "timberio/vector:0.61.3-distroless-libc@sha256:0.61.3-distroless-libc" {
		t.Errorf("got %+v", report)
	}
	if report.ahead != "timberio/vector:0.62.0-distroless-libc" {
		t.Errorf("a new minor version below 1.0 should need a person: %+v", report)
	}
	previous := values(t, "logs: {vector: {image: 'timberio/vector:0.61.5-distroless-libc'}}")
	report = reportImage(entry, chart, values(t, "{}"), previous, lookups(tags, digestOf), nil, openGate())
	if report.chosen != "timberio/vector:0.61.5-distroless-libc@sha256:0.61.5-distroless-libc" {
		t.Errorf("went backwards: %+v", report)
	}
	older := values(t, "logs: {vector: {image: 'timberio/vector:0.50.0-distroless-libc'}}")
	report = reportImage(entry, chart, values(t, "{}"), older, lookups(tags, digestOf), nil, openGate())
	if report.running != "timberio/vector:0.61.0-distroless-libc" {
		t.Errorf("a new chart should win over an older record: %+v", report)
	}
}

func TestReportWaitsForTheSoak(t *testing.T) {
	entry := bundledImage{path: "metrics.vmagent.image"}
	chart := values(t, "metrics: {vmagent: {image: 'victoriametrics/vmagent:v1.156.0'}}")
	tags := func(string) ([]string, error) { return []string{"v1.156.0", "v1.157.0", "v1.158.0"}, nil }
	dates := map[string]time.Time{"v1.157.0": fixedNow.Add(-9 * day), "v1.158.0": fixedNow.Add(-2 * day)}
	gate := &updateGate{now: func() time.Time { return fixedNow }, soak: 7 * day}
	look := lookups(tags, digestOf)
	look.published = func(_, tag string) (time.Time, error) {
		if at, ok := dates[tag]; ok {
			return at, nil
		}
		return time.Time{}, errors.New("unknown")
	}
	report := reportImage(entry, chart, values(t, "{}"), values(t, "{}"), look, nil, gate)
	if report.chosen != "victoriametrics/vmagent:v1.157.0@sha256:v1.157.0" {
		t.Errorf("got %+v", report)
	}
	if len(report.notes) != 1 || !strings.Contains(report.notes[0], "v1.158.0 is out and waits") {
		t.Errorf("notes %v", report.notes)
	}
}

func TestReportKeepsTheVersionWhenARegistryFails(t *testing.T) {
	failure := errors.New("no route")
	report := reportImage(bundledImage{path: "redis.image"},
		values(t, "redis: {image: 'redis:8.10.3-alpine'}"), values(t, "{}"), values(t, "{}"),
		lookups(func(string) ([]string, error) { return nil, failure }, noDigest(t)), nil, openGate())
	if !errors.Is(report.err, failure) || report.chosen != "redis:8.10.3-alpine" {
		t.Errorf("got %+v", report)
	}
}

func digestOf(_, tag string) (string, error) {
	return "sha256:" + tag, nil
}

func noDigest(t *testing.T) func(string, string) (string, error) {
	return func(string, string) (string, error) {
		t.Fatal("no digest lookup expected")
		return "", nil
	}
}

func TestReportKeepsAPinnedChartDigest(t *testing.T) {
	chart := values(t, "redis: {image: 'redis:8.10.3-alpine@sha256:chart'}")
	tags := func(string) ([]string, error) { return []string{"8.10.3-alpine", "8.11.0-alpine"}, nil }
	report := reportImage(bundledImage{path: "redis.image", patchOnly: true}, chart, values(t, "{}"), values(t, "{}"), lookups(tags, noDigest(t)), nil, openGate())
	if report.chosen != "redis:8.10.3-alpine@sha256:chart" || report.ahead != "redis:8.11.0-alpine" {
		t.Errorf("got %+v", report)
	}
	unpinned := values(t, "redis: {image: 'redis:8.10.3-alpine'}")
	report = reportImage(bundledImage{path: "redis.image", patchOnly: true}, unpinned, values(t, "{}"), values(t, "{}"), lookups(tags, digestOf), nil, openGate())
	if report.chosen != "redis:8.10.3-alpine@sha256:8.10.3-alpine" {
		t.Errorf("a tag without a digest should be pinned: %+v", report)
	}
	failure := errors.New("no digest")
	report = reportImage(bundledImage{path: "redis.image"}, unpinned, values(t, "{}"), values(t, "{}"),
		lookups(func(string) ([]string, error) { return []string{"8.10.4-alpine"}, nil },
			func(string, string) (string, error) { return "", failure }), nil, openGate())
	if !errors.Is(report.err, failure) || report.chosen != "redis:8.10.3-alpine" {
		t.Errorf("a failed digest lookup should keep the version: %+v", report)
	}
}

func TestEveryChartImageIsPinnedToADigest(t *testing.T) {
	raw, err := os.ReadFile("../../../../../infra/charts/orchard/values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	chart := values(t, string(raw))
	for _, entry := range bundledImages {
		image := imageAt(chart, entry.path)
		if _, _, ok := splitImage(image); !ok || !strings.Contains(image, "@sha256:") {
			t.Errorf("%s is %q, not a tag pinned to a digest", entry.path, image)
		}
	}
}

func TestPodsNotReadyCountsOnlyThatImage(t *testing.T) {
	body := []byte(`{"items":[
	  {"spec":{"containers":[{"name":"a","image":"x:2"}]},"status":{"phase":"Running","containerStatuses":[{"name":"a","ready":true}]}},
	  {"spec":{"containers":[{"name":"a","image":"x:2"}]},"status":{"phase":"Pending","containerStatuses":[{"name":"a","ready":false}]}},
	  {"spec":{"containers":[{"name":"a","image":"x:2"}]},"status":{"phase":"Succeeded","containerStatuses":[{"name":"a","ready":false}]}},
	  {"metadata":{"deletionTimestamp":"now"},"spec":{"containers":[{"name":"a","image":"x:2"}]},"status":{"phase":"Running"}},
	  {"spec":{"containers":[{"name":"a","image":"y:1"}]},"status":{"phase":"Pending"}}
	]}`)
	total, notReady, err := podsNotReady(body, "x:2")
	if err != nil || total != 2 || notReady != 1 {
		t.Errorf("got %d %d %v", total, notReady, err)
	}
}

func TestRunningDigests(t *testing.T) {
	got := runningDigests([]byte(`{"items":[{"status":{"containerStatuses":[{"imageID":"ghcr.io/a/b@sha256:abc"}]}}]}`))
	if len(got) != 1 || got[0] != "sha256:abc" {
		t.Errorf("got %v", got)
	}
}

func TestParseHeld(t *testing.T) {
	held := parseHeld("a:1\n\n  b:2  \n")
	if !held["a:1"] || !held["b:2"] || len(held) != 2 {
		t.Errorf("got %v", held)
	}
}

func TestEveryBundledImageIsInTheChart(t *testing.T) {
	raw, err := os.ReadFile("../../../../../infra/charts/orchard/values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	chart := values(t, string(raw))
	for _, entry := range bundledImages {
		if imageAt(chart, entry.path) == "" {
			t.Errorf("%s isn't set in the chart", entry.path)
		}
	}
}

func TestChartBuilderVersionsMatchTheServer(t *testing.T) {
	raw, err := os.ReadFile("../../../../../infra/charts/orchard/values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	chart := values(t, string(raw))
	checks := map[string]string{
		"builders.buildkitImage":   "../../../src/docker/buildkit-image.ts",
		"builders.railpackVersion": "../../../src/docker/image-builder.service.ts",
	}
	for path, file := range checks {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		want := imageAt(chart, path)
		if want == "" || !regexp.MustCompile(regexp.QuoteMeta("'"+want+"'")).Match(source) {
			t.Errorf("%s is %q, which %s doesn't use", path, want, file)
		}
	}
}

func TestMovingImage(t *testing.T) {
	for image, want := range map[string]bool{
		"ghcr.io/hackclub/orchard/server:latest":            true,
		"ghcr.io/hackclub/orchard/server":                   true,
		"":                                                  true,
		"ghcr.io/hackclub/orchard/server:2.95.4":            false,
		"ghcr.io/hackclub/orchard/server:e2e":               false,
		"ghcr.io/hackclub/orchard/server:latest@sha256:abc": false,
		"localhost:5000/orchard/server":                     true,
	} {
		if got := movingImage(image); got != want {
			t.Errorf("%q: expected %v, got %v", image, want, got)
		}
	}
}
