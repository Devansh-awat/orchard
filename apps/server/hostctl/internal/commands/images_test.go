package commands

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"

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

func TestChooseStaysInTheSameMajorAndFlavour(t *testing.T) {
	tags := []string{"v1.154.1", "v1.155.0", "v1.160.2", "v2.0.0", "1.999.0", "v1.200.0-rc1", "latest"}
	best, ahead := chooseImageTag(mustTag(t, "v1.154.1"), tags, false, nil, "repo")
	if best.raw != "v1.160.2" {
		t.Errorf("best %s", best.raw)
	}
	if ahead.raw != "v2.0.0" {
		t.Errorf("ahead %s", ahead.raw)
	}
}

func TestChooseKeepsTheAlpineFlavour(t *testing.T) {
	tags := []string{"7.4.11-alpine", "7.4.12-alpine", "7.4.13", "7.4.14-bookworm", "7.6.0-alpine", "8.0.0-alpine"}
	best, ahead := chooseImageTag(mustTag(t, "7.4.11-alpine"), tags, true, nil, "redis")
	if best.raw != "7.4.12-alpine" {
		t.Errorf("patch-only best %s", best.raw)
	}
	if ahead.raw != "8.0.0-alpine" {
		t.Errorf("ahead %s", ahead.raw)
	}
}

func TestChooseSkipsAHeldVersion(t *testing.T) {
	held := map[string]bool{"repo:v1.156.0": true}
	best, _ := chooseImageTag(mustTag(t, "v1.155.0"), []string{"v1.155.0", "v1.156.0"}, false, held, "repo")
	if best.raw != "v1.155.0" {
		t.Errorf("a held version was chosen: %s", best.raw)
	}
	best, _ = chooseImageTag(mustTag(t, "v1.155.0"), []string{"v1.156.0", "v1.157.0"}, false, held, "repo")
	if best.raw != "v1.157.0" {
		t.Errorf("a newer version than the held one should be tried: %s", best.raw)
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

func TestReportLeavesAnImageTheUserSet(t *testing.T) {
	report := reportImage(bundledImage{path: "redis.image", patchOnly: true},
		values(t, "redis: {image: 'redis:8.10.3-alpine'}"),
		values(t, "redis: {image: 'my.registry/redis:6.0.0'}"),
		values(t, "{}"),
		func(string) ([]string, error) { t.Fatal("no registry call for a pinned image"); return nil, nil },
		nil)
	if !report.pinned || report.chosen != "my.registry/redis:6.0.0" {
		t.Errorf("got %+v", report)
	}
}

func TestReportNeverGoesBelowTheChartOrTheLastVersion(t *testing.T) {
	entry := bundledImage{path: "logs.vector.image"}
	chart := values(t, "logs: {vector: {image: 'timberio/vector:0.61.0-distroless-libc'}}")
	tags := func(string) ([]string, error) {
		return []string{"0.60.0-distroless-libc", "0.61.0-distroless-libc", "0.62.0-distroless-libc"}, nil
	}
	report := reportImage(entry, chart, values(t, "{}"), values(t, "{}"), tags, nil)
	if report.running != "timberio/vector:0.61.0-distroless-libc" || report.chosen != "timberio/vector:0.62.0-distroless-libc" {
		t.Errorf("got %+v", report)
	}
	previous := values(t, "logs: {vector: {image: 'timberio/vector:0.63.0-distroless-libc'}}")
	report = reportImage(entry, chart, values(t, "{}"), previous, tags, nil)
	if report.chosen != "timberio/vector:0.63.0-distroless-libc" {
		t.Errorf("went backwards: %+v", report)
	}
	older := values(t, "logs: {vector: {image: 'timberio/vector:0.50.0-distroless-libc'}}")
	report = reportImage(entry, chart, values(t, "{}"), older, tags, nil)
	if report.running != "timberio/vector:0.61.0-distroless-libc" {
		t.Errorf("a new chart should win over an older record: %+v", report)
	}
}

func TestReportKeepsTheVersionWhenARegistryFails(t *testing.T) {
	failure := errors.New("no route")
	report := reportImage(bundledImage{path: "redis.image"},
		values(t, "redis: {image: 'redis:8.10.3-alpine'}"), values(t, "{}"), values(t, "{}"),
		func(string) ([]string, error) { return nil, failure }, nil)
	if !errors.Is(report.err, failure) || report.chosen != "redis:8.10.3-alpine" {
		t.Errorf("got %+v", report)
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
