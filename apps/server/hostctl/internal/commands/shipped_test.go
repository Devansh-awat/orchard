package commands

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func TestAddonPinReadsTheInstaller(t *testing.T) {
	cnpg, traefik, certManager := addons[1], addons[0], addons[2]
	script := `#!/usr/bin/env bash
CNPG_CHART_VERSION=${CNPG_CHART_VERSION:-0.29.1}
CERT_MANAGER_PINNED=v1.21.3
CERT_MANAGER_CHART_VERSION=${CERT_MANAGER_CHART_VERSION:-$CERT_MANAGER_PINNED}
install() {
  CNPG_CHART_VERSION=$cnpg_target
}
`
	if v, setting := addonPin(script, cnpg); v != "0.29.1" || setting != "CNPG_CHART_VERSION" {
		t.Errorf("cnpg: %q %q", v, setting)
	}
	if v, setting := addonPin(script, certManager); v != "v1.21.3" || setting != "CERT_MANAGER_CHART_VERSION" {
		t.Errorf("cert-manager: %q %q", v, setting)
	}
	if v, setting := addonPin(script, traefik); v != "" || setting != "" {
		t.Errorf("an unpinned chart: %q %q", v, setting)
	}
	flagged := "run_step \"Traefik\" 1m helm upgrade --install traefik traefik/traefik \\\n    --namespace traefik \\\n    --version 42.4.0 \\\n    --wait\n" +
		"helm upgrade --install cnpg cnpg/cloudnative-pg --version \"$1\"\n"
	if v, setting := addonPin(flagged, traefik); v != "42.4.0" || !strings.Contains(setting, "--version") {
		t.Errorf("traefik: %q %q", v, setting)
	}
	if v, _ := addonPin(flagged, cnpg); v != "" {
		t.Errorf("a function argument isn't a pin: %q", v)
	}
}

func TestScriptImageFindsThePin(t *testing.T) {
	script := "      image: ghcr.io/project-zot/zot:v2.1.23@sha256:" + strings.Repeat("a", 64) + "\n  image: cloudflare/cloudflared:2026.11.0\n"
	if got := scriptImage(script, "ghcr.io/project-zot/zot"); got != "ghcr.io/project-zot/zot:v2.1.23@sha256:"+strings.Repeat("a", 64) {
		t.Errorf("zot: %q", got)
	}
	if got := scriptImage(script, "cloudflare/cloudflared"); got != "cloudflare/cloudflared:2026.11.0" {
		t.Errorf("cloudflared: %q", got)
	}
	if got := scriptImage(script, "flare/cloudflared"); got != "" {
		t.Errorf("a different repository matched: %q", got)
	}
}

type fakeAdvisories struct {
	affected map[string][]string
	details  map[string]string
	down     bool
}

func (f *fakeAdvisories) serve(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.down {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		if id, ok := strings.CutPrefix(r.URL.Path, "/vulns/"); ok {
			body, found := f.details[id]
			if !found {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, body)
			return
		}
		var body struct {
			Queries []osvQuery `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		type vuln struct {
			ID string `json:"id"`
		}
		type result struct {
			Vulns []vuln `json:"vulns,omitempty"`
		}
		var out struct {
			Results []result `json:"results"`
		}
		for _, q := range body.Queries {
			var res result
			for _, id := range f.affected[q.Package.Name+"@"+q.Version] {
				res.Vulns = append(res.Vulns, vuln{ID: id})
			}
			out.Results = append(out.Results, res)
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(server.Close)
	return server
}

const fakeCNPGIndex = `apiVersion: v1
entries:
  cloudnative-pg:
  - {version: 0.27.0, appVersion: 1.28.0}
  - {version: 0.26.2, appVersion: 1.27.2}
  - {version: 0.26.1, appVersion: 1.27.1}
`

const fakeTraefikIndex = `apiVersion: v1
entries:
  traefik:
  - {version: 42.4.0, appVersion: v3.7.18}
  - {version: 43.0.0-rc1, appVersion: v3.8.0-rc1}
`

const fakeCertManagerIndex = `apiVersion: v1
entries:
  cert-manager:
  - {version: v1.21.3, appVersion: v1.21.3}
`

func shippedRoot(t *testing.T, images map[string]string, script string) string {
	t.Helper()
	root := t.TempDir()
	valuesPath := filepath.Join(root, shippedValuesFile)
	if err := os.MkdirAll(filepath.Dir(valuesPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(valuesPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	values, err := cli.LoadValues(valuesPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range bundledImages {
		image := "example.com/" + strings.ReplaceAll(entry.path, ".", "-") + ":1.0.0"
		if override, ok := images[entry.path]; ok {
			image = override
		}
		if err := values.Put(entry.path, image); err != nil {
			t.Fatal(err)
		}
	}
	if err := values.Save(); err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(root, shippedInstallFile)
	if err := os.MkdirAll(filepath.Dir(scriptPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scriptPath, []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

const shippedScript = `#!/usr/bin/env bash
CNPG_CHART_VERSION=${CNPG_CHART_VERSION:-0.26.1}
          image: ghcr.io/project-zot/zot:v2.1.23
          image: cloudflare/cloudflared:2026.11.0
`

func fakeSources(t *testing.T, osv *fakeAdvisories, tags map[string][]string, listed *[]string) shippedSources {
	server := osv.serve(t)
	indexes := map[string]string{
		"https://cloudnative-pg.github.io/charts": fakeCNPGIndex,
		"https://traefik.github.io/charts":        fakeTraefikIndex,
		"https://charts.jetstack.io":              fakeCertManagerIndex,
	}
	return shippedSources{
		osv:     &osvClient{http: &http.Client{Timeout: 5 * time.Second}, url: server.URL + "/querybatch"},
		vulnURL: server.URL + "/vulns/",
		tags: func(repo string) ([]string, error) {
			*listed = append(*listed, repo)
			if list, ok := tags[repo]; ok {
				return list, nil
			}
			return nil, fmt.Errorf("no tags for %s", repo)
		},
		digest: func(repo, tag string) (string, error) {
			return "sha256:" + strings.Repeat("d", 64), nil
		},
		chartIndex: func(repo string) ([]byte, error) {
			if index, ok := indexes[repo]; ok {
				return []byte(index), nil
			}
			return nil, fmt.Errorf("no index at %s", repo)
		},
	}
}

func shippedAdvisories() *fakeAdvisories {
	return &fakeAdvisories{
		affected: map[string][]string{
			"github.com/aquasecurity/trivy@0.69.3":            {"GHSA-tttt-tttt-tttt", "GO-2026-0001"},
			"github.com/aquasecurity/trivy@0.69.4":            {"GHSA-tttt-tttt-tttt", "GO-2026-0001"},
			"github.com/cloudnative-pg/cloudnative-pg@1.27.1": {"GHSA-cccc-cccc-cccc"},
			"github.com/cloudnative-pg/cloudnative-pg@1.27.2": {"GHSA-cccc-cccc-cccc"},
			"zotregistry.dev/zot/v2@2.1.23":                   {"GHSA-zzzz-zzzz-zzzz"},
			"zotregistry.dev/zot/v2@2.1.24":                   {"GHSA-zzzz-zzzz-zzzz"},
		},
		details: map[string]string{
			"GHSA-tttt-tttt-tttt": `{"id":"GHSA-tttt-tttt-tttt","summary":"Path traversal | in the plugin manager","aliases":["GO-2026-0001"],"database_specific":{"severity":"HIGH"},
				"affected":[{"package":{"ecosystem":"Go","name":"github.com/aquasecurity/trivy"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"0.70.0"}]}]}]}`,
			"GO-2026-0001": `{"id":"GO-2026-0001","summary":"Path traversal","aliases":["GHSA-tttt-tttt-tttt"],
				"affected":[{"package":{"ecosystem":"Go","name":"github.com/aquasecurity/trivy"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"0.70.0"}]}]}]}`,
			"GHSA-cccc-cccc-cccc": `{"id":"GHSA-cccc-cccc-cccc","summary":"Metrics exporter escalation","database_specific":{"severity":"CRITICAL"},
				"affected":[{"package":{"ecosystem":"Go","name":"github.com/cloudnative-pg/cloudnative-pg"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"1.28.0"}]}]},
				{"package":{"ecosystem":"Go","name":"github.com/other/thing"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"9.9.9"}]}]}]}`,
		},
	}
}

func TestCheckShippedSortsWhatNeedsYou(t *testing.T) {
	root := shippedRoot(t, map[string]string{"trivy.image": "ghcr.io/aquasecurity/trivy:0.69.3@sha256:" + strings.Repeat("0", 64)}, shippedScript)
	tags := map[string][]string{
		"ghcr.io/aquasecurity/trivy": {"0.69.3", "0.69.4", "0.70.0", "0.70.1", "1.0.0"},
		"ghcr.io/project-zot/zot":    {"v2.1.23", "v2.1.24"},
	}
	var listed []string
	report, err := checkShipped(root, fakeSources(t, shippedAdvisories(), tags, &listed))
	if err != nil {
		t.Fatal(err)
	}
	if report.Status() != ShippedNeedsYou {
		t.Fatalf("status %d\n%s", report.Status(), report.Text())
	}
	if got := strings.Join(listed, " "); got != "ghcr.io/aquasecurity/trivy ghcr.io/project-zot/zot" {
		t.Errorf("only an affected image needs its tags: %s", got)
	}
	byName := map[string]shippedResult{}
	for _, r := range report.results {
		byName[r.component.name] = r
	}

	trivy := byName["trivy.image"]
	if !trivy.needsYou() || trivy.host.target.tag.raw != "0.70.1" || !trivy.host.target.securityOnly {
		t.Errorf("trivy: hosts should cross into 0.70: %s", trivy.host.target.tag.raw)
	}
	if trivy.onHosts() != "orchardctl update moves to 0.70.1 on its own" {
		t.Errorf("trivy on hosts: %q", trivy.onHosts())
	}
	if trivy.todo() != "set trivy.image in infra/charts/orchard/values.yaml to ghcr.io/aquasecurity/trivy:1.0.0@sha256:"+strings.Repeat("d", 64) {
		t.Errorf("trivy to do: %q", trivy.todo())
	}
	if got := strings.Join(trivy.displayed(), ","); got != "GHSA-tttt-tttt-tttt" {
		t.Errorf("a Go advisory with a GitHub alias should fold into it: %s", got)
	}

	cnpg := byName["cloudnative-pg"]
	if !cnpg.needsYou() || cnpg.shipped != "0.26.1 (1.27.1)" {
		t.Errorf("cnpg: %+v", cnpg)
	}
	if !strings.HasPrefix(cnpg.onHosts(), "needs a person: cloudnative-pg 0.27.0 fixes it, and is a new minor version below 1.0") {
		t.Errorf("cnpg on hosts: %q", cnpg.onHosts())
	}
	if cnpg.todo() != "set CNPG_CHART_VERSION in install/install.sh to 0.27.0" {
		t.Errorf("cnpg to do: %q", cnpg.todo())
	}
	if got := strings.Join(cnpg.fixedIn(), ","); got != "1.28.0" {
		t.Errorf("cnpg fixed in %s", got)
	}

	zot := byName["zot"]
	if zot.onHosts() != "no release fixes it yet" || !strings.HasPrefix(zot.todo(), "no release fixes GHSA-zzzz-zzzz-zzzz yet") {
		t.Errorf("zot: %q %q", zot.onHosts(), zot.todo())
	}

	traefik := byName["traefik"]
	if traefik.shipped != "42.4.0 (v3.7.18)" || traefik.needsYou() {
		t.Errorf("an unpinned chart is checked at its newest release: %+v", traefik)
	}
	if !strings.HasPrefix(byName["logs.victorialogs.image"].state(), "not checked") {
		t.Errorf("victorialogs: %s", byName["logs.victorialogs.image"].state())
	}

	text := report.Text()
	for _, want := range []string{
		"trivy.image                        0.69.3                   needs you",
		"  GHSA-tttt-tttt-tttt (GO-2026-0001) HIGH, fixed in 0.70.0: Path traversal | in the plugin manager",
		"    https://osv.dev/vulnerability/GHSA-tttt-tttt-tttt",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("text lacks %q:\n%s", want, text)
		}
	}
	md := report.Markdown()
	for _, want := range []string{
		"**3 shipped component(s) have advisories.**",
		"| `trivy.image` | `0.69.3` | [GHSA-tttt-tttt-tttt](https://osv.dev/vulnerability/GHSA-tttt-tttt-tttt) HIGH: Path traversal \\| in the plugin manager | 0.70.0 |",
		"| `cloudnative-pg` | `install/install.sh` | `0.26.1 (1.27.1)` | needs you |",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
}

func TestCheckShippedPassesWithoutAdvisories(t *testing.T) {
	root := shippedRoot(t, nil, shippedScript)
	osv := &fakeAdvisories{}
	var listed []string
	report, err := checkShipped(root, fakeSources(t, osv, nil, &listed))
	if err != nil {
		t.Fatal(err)
	}
	if report.Status() != ShippedClean || len(listed) != 0 {
		t.Errorf("status %d listed %v\n%s", report.Status(), listed, report.Text())
	}
	if !strings.Contains(report.Markdown(), "No shipped component has a known advisory.") {
		t.Errorf("markdown:\n%s", report.Markdown())
	}
}

func TestCheckShippedSaysWhenOSVIsDown(t *testing.T) {
	root := shippedRoot(t, nil, shippedScript)
	var listed []string
	report, err := checkShipped(root, fakeSources(t, &fakeAdvisories{down: true}, nil, &listed))
	if err != nil {
		t.Fatal(err)
	}
	if report.Status() != ShippedUnreachable {
		t.Errorf("status %d", report.Status())
	}
	if !strings.Contains(report.Text(), "could not check: api.osv.dev answered 503") || !strings.Contains(report.Markdown(), "**Could not check") {
		t.Errorf("text:\n%s", report.Text())
	}
}

func TestCheckShippedNeedsEveryPin(t *testing.T) {
	root := shippedRoot(t, nil, "#!/usr/bin/env bash\n")
	var listed []string
	if _, err := checkShipped(root, fakeSources(t, &fakeAdvisories{}, nil, &listed)); err == nil || !strings.Contains(err.Error(), "ghcr.io/project-zot/zot") {
		t.Errorf("a missing zot pin should fail: %v", err)
	}
}

func TestTheRepositoryShipsEveryComponent(t *testing.T) {
	components, err := shippedComponents(filepath.Join("..", "..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if len(components) != len(addons)+len(bundledImages)+len(floatingWorkloads) {
		t.Errorf("got %d components", len(components))
	}
	for _, c := range components {
		if c.addon == nil && c.pin == "" {
			t.Errorf("%s has no pin", c.name)
		}
	}
}
