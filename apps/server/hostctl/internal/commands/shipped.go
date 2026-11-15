package commands

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	ShippedClean       = 0
	ShippedNeedsYou    = 1
	ShippedUnreachable = 3

	shippedValuesFile  = "infra/charts/orchard/values.yaml"
	shippedInstallFile = "install/install.sh"
)

var osvVulnURL = "https://api.osv.dev/v1/vulns/"

type shippedSources struct {
	osv        *osvClient
	vulnURL    string
	tags       func(repo string) ([]string, error)
	digest     func(repo, tag string) (string, error)
	chartIndex func(repo string) ([]byte, error)
}

func liveShippedSources() shippedSources {
	registry := newRegistryClient()
	return shippedSources{
		osv:        newOSVClient(),
		vulnURL:    osvVulnURL,
		tags:       registry.tags,
		digest:     registry.digest,
		chartIndex: fetchChartIndex,
	}
}

type shipped struct {
	name               string
	file               string
	setting            string
	pin                string
	addon              *addon
	patchOnly          bool
	anyMajor           bool
	securityCrossMinor bool
	why                string
	osv                []osvPackage
}

var (
	scriptAssignment = regexp.MustCompile(`(?m)^[ \t]*(?:export[ \t]+|readonly[ \t]+)?([A-Z][A-Z0-9_]*)=(\S*)`)
	scriptDefault    = regexp.MustCompile(`^"?\$\{([A-Z][A-Z0-9_]*):?-([^}]*)\}"?$`)
	scriptReference  = regexp.MustCompile(`^"?\$\{?([A-Z][A-Z0-9_]*)\}?"?$`)
	helmVersionFlag  = regexp.MustCompile(`--version[= ]+(\S+)`)
)

func scriptVariables(script string) map[string]string {
	vars := map[string]string{}
	for _, m := range scriptAssignment.FindAllStringSubmatch(script, -1) {
		if _, seen := vars[m[1]]; !seen {
			vars[m[1]] = m[2]
		}
	}
	return vars
}

func scriptValue(vars map[string]string, raw string, depth int) string {
	if depth > 8 {
		return ""
	}
	if m := scriptDefault.FindStringSubmatch(raw); m != nil {
		return scriptValue(vars, m[2], depth+1)
	}
	if m := scriptReference.FindStringSubmatch(raw); m != nil {
		return scriptValue(vars, vars[m[1]], depth+1)
	}
	return strings.Trim(raw, `"'`)
}

func scriptEnvName(s string) string {
	return strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(s))
}

func addonPin(script string, a addon) (version, setting string) {
	vars := scriptVariables(script)
	for _, name := range []string{scriptEnvName(a.release) + "_CHART_VERSION", scriptEnvName(a.chart) + "_CHART_VERSION"} {
		raw, ok := vars[name]
		if !ok {
			continue
		}
		if v := scriptValue(vars, raw, 0); v != "" {
			if _, ok := parseImageTag(v); ok {
				return v, name
			}
		}
	}
	joined := strings.ReplaceAll(script, "\\\n", " ")
	for _, line := range strings.Split(joined, "\n") {
		if !strings.Contains(line, "helm upgrade --install "+a.release+" ") {
			continue
		}
		if m := helmVersionFlag.FindStringSubmatch(line); m != nil {
			if v := scriptValue(vars, m[1], 0); v != "" {
				if _, ok := parseImageTag(v); ok {
					return v, "--version of helm upgrade --install " + a.release
				}
			}
		}
	}
	return "", ""
}

func scriptImage(script, repo string) string {
	pattern := regexp.MustCompile(`(?:^|[\s"'=])(` + regexp.QuoteMeta(repo) + `:[A-Za-z0-9._-]+(?:@sha256:[0-9a-f]{64})?)`)
	if m := pattern.FindStringSubmatch(script); m != nil {
		return m[1]
	}
	return ""
}

func shippedComponents(root string) ([]shipped, error) {
	rawValues, err := os.ReadFile(filepath.Join(root, shippedValuesFile))
	if err != nil {
		return nil, err
	}
	values, err := cli.ParseValues(rawValues)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", shippedValuesFile, err)
	}
	rawScript, err := os.ReadFile(filepath.Join(root, shippedInstallFile))
	if err != nil {
		return nil, err
	}
	script := string(rawScript)
	var out []shipped
	for i := range addons {
		a := addons[i]
		version, setting := addonPin(script, a)
		out = append(out, shipped{
			name: a.chart, file: shippedInstallFile, setting: setting, pin: version, addon: &a,
			securityCrossMinor: a.securityCrossMinor, why: a.why, osv: a.osv,
		})
	}
	for _, entry := range bundledImages {
		pin := imageAt(values, entry.path)
		if pin == "" {
			return nil, fmt.Errorf("%s has no %s", shippedValuesFile, entry.path)
		}
		out = append(out, shipped{
			name: entry.path, file: shippedValuesFile, setting: entry.path, pin: pin,
			patchOnly: entry.patchOnly, securityCrossMinor: entry.securityCrossMinor, why: entry.why, osv: entry.osv,
		})
	}
	for _, w := range floatingWorkloads {
		pin := scriptImage(script, w.repo)
		if pin == "" {
			return nil, fmt.Errorf("%s has no %s image", shippedInstallFile, w.repo)
		}
		out = append(out, shipped{
			name: w.name, file: shippedInstallFile, setting: "the " + w.name + " image", pin: pin,
			anyMajor: w.anyMajor, securityCrossMinor: w.securityCrossMinor, why: w.why, osv: w.osv,
		})
	}
	return out, nil
}

type advisoryDetail struct {
	summary  string
	severity string
	aliases  []string
	fixed    []string
}

func (s shippedSources) detail(id string, names map[string]bool) (advisoryDetail, error) {
	req, err := http.NewRequest(http.MethodGet, s.vulnURL+url.PathEscape(id), nil)
	if err != nil {
		return advisoryDetail{}, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := s.osv.http.Do(req)
	if err != nil {
		return advisoryDetail{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return advisoryDetail{}, fmt.Errorf("api.osv.dev answered %d for %s", res.StatusCode, id)
	}
	var doc struct {
		Summary  string   `json:"summary"`
		Aliases  []string `json:"aliases"`
		Severity []struct {
			Type  string `json:"type"`
			Score string `json:"score"`
		} `json:"severity"`
		DatabaseSpecific struct {
			Severity string `json:"severity"`
		} `json:"database_specific"`
		Affected []struct {
			Package struct {
				Name string `json:"name"`
			} `json:"package"`
			Ranges []struct {
				Type   string `json:"type"`
				Events []struct {
					Fixed string `json:"fixed"`
				} `json:"events"`
			} `json:"ranges"`
		} `json:"affected"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&doc); err != nil {
		return advisoryDetail{}, err
	}
	d := advisoryDetail{summary: doc.Summary, aliases: doc.Aliases, severity: strings.ToUpper(doc.DatabaseSpecific.Severity)}
	if d.severity == "" && len(doc.Severity) > 0 {
		d.severity = doc.Severity[0].Type
	}
	seen := map[string]bool{}
	for _, a := range doc.Affected {
		if !names[a.Package.Name] {
			continue
		}
		for _, r := range a.Ranges {
			if r.Type == "GIT" {
				continue
			}
			for _, e := range r.Events {
				if e.Fixed != "" && !seen[e.Fixed] {
					seen[e.Fixed] = true
					d.fixed = append(d.fixed, e.Fixed)
				}
			}
		}
	}
	sortVersions(d.fixed)
	return d, nil
}

func sortVersions(versions []string) {
	sort.SliceStable(versions, func(i, j int) bool {
		a, okA := parseImageTag(versions[i])
		b, okB := parseImageTag(versions[j])
		if okA && okB {
			return b.newerThan(a)
		}
		return versions[i] < versions[j]
	})
}

type shippedResult struct {
	component shipped
	shipped   string
	current   candidate
	ids       []string
	details   map[string]advisoryDetail
	host      decision
	pin       decision
	bump      string
	skipped   string
	err       error
}

func (r shippedResult) needsYou() bool {
	return r.err == nil && r.skipped == "" && len(r.ids) > 0
}

func (r shippedResult) packageNames() map[string]bool {
	names := map[string]bool{}
	for _, p := range r.component.osv {
		if r.current.hasApp {
			names[p.nameFor(r.current.app)] = true
		}
	}
	return names
}

func checkComponent(src shippedSources, c shipped) shippedResult {
	r := shippedResult{component: c, shipped: c.pin}
	if _, rawTag, ok := splitImage(c.pin); ok && c.addon == nil {
		r.shipped = rawTag
	}
	if len(c.osv) == 0 {
		r.skipped = "OSV.dev has no package that matches its versions"
		return r
	}
	gate := &updateGate{now: time.Now, osv: src.osv}
	if c.addon != nil {
		checkAddon(src, gate, &r)
	} else {
		checkImage(src, gate, &r)
	}
	if r.err == nil && gate.osvErr != nil {
		r.err = gate.osvErr
	}
	if r.err != nil || len(r.ids) == 0 {
		return r
	}
	r.details = map[string]advisoryDetail{}
	names := r.packageNames()
	for _, id := range r.ids {
		if d, err := src.detail(id, names); err == nil {
			r.details[id] = d
		}
	}
	return r
}

func (r *shippedResult) advisoriesOfCurrent(src shippedSources) bool {
	known, err := src.osv.advisories(r.component.osv, []imageTag{r.current.app})
	if err != nil {
		r.err = err
		return false
	}
	r.ids = known[osvVersion(r.current.app)]
	return len(r.ids) > 0
}

func checkImage(src shippedSources, gate *updateGate, r *shippedResult) {
	c := r.component
	repo, rawTag, ok := splitImage(c.pin)
	if !ok {
		r.skipped = "its image has no tag"
		return
	}
	tag, ok := parseImageTag(rawTag)
	if !ok {
		r.skipped = "its tag " + rawTag + " isn't a version"
		return
	}
	r.shipped = rawTag
	r.current = imageCandidate(tag)
	if !r.advisoriesOfCurrent(src) {
		return
	}
	tags, err := src.tags(repo)
	if err != nil {
		r.err = fmt.Errorf("couldn't list the tags of %s: %w", repo, err)
		return
	}
	hostCandidates, ahead := imageCandidates(tag, tags, c.patchOnly, c.anyMajor, c.securityCrossMinor, nil, repo)
	r.host = planImage(gate, c.osv, repo, tag, hostCandidates, ahead, nil)
	every, _ := imageCandidates(tag, tags, false, true, false, nil, repo)
	r.pin = gate.plan(c.osv, r.current, every, nil, nil)
	if r.pin.moves(r.current) && len(r.pin.fixed) > 0 {
		r.bump = repo + ":" + r.pin.target.tag.raw
		if digest, err := src.digest(repo, r.pin.target.tag.raw); err == nil {
			r.bump = pinnedRef(repo, r.pin.target.tag.raw, digest)
		}
	}
}

func checkAddon(src shippedSources, gate *updateGate, r *shippedResult) {
	a := *r.component.addon
	raw, err := src.chartIndex(a.repo)
	if err != nil {
		r.err = fmt.Errorf("couldn't read the %s chart repository: %w", a.chart, err)
		return
	}
	releases, err := parseChartIndex(raw, a.chart)
	if err != nil {
		r.err = err
		return
	}
	version := r.component.pin
	if version == "" {
		var newest *imageTag
		for _, release := range releases {
			if tag, ok := parseImageTag(release.version); ok && tag.suffix == "" && (newest == nil || tag.newerThan(*newest)) {
				newest = &tag
			}
		}
		if newest == nil {
			r.err = fmt.Errorf("the %s chart repository lists no release", a.chart)
			return
		}
		version = newest.raw
	}
	appVersion, found := "", false
	for _, release := range releases {
		if release.version == version {
			appVersion, found = release.appVersion, true
		}
	}
	if !found {
		r.err = fmt.Errorf("the %s chart repository doesn't list %s", a.chart, version)
		return
	}
	current, ok := chartCandidate(version, appVersion)
	if !ok || !current.hasApp {
		r.skipped = fmt.Sprintf("chart %s names no application version", version)
		return
	}
	r.shipped = version + " (" + appVersion + ")"
	r.current = current
	if !r.advisoriesOfCurrent(src) {
		return
	}
	plan, err := planAddon(gate, a, installedChart{version: version, appVersion: appVersion}, releases)
	if err != nil {
		r.err = err
		return
	}
	r.host = plan.decision
	var every []candidate
	for _, release := range releases {
		next, ok := chartCandidate(release.version, release.appVersion)
		if ok && next.tag.prefix == current.tag.prefix && next.tag.suffix == current.tag.suffix && next.tag.newerThan(current.tag) {
			every = append(every, next)
		}
	}
	sort.Slice(every, func(i, j int) bool { return every[j].tag.newerThan(every[i].tag) })
	r.pin = gate.plan(a.osv, current, every, nil, nil)
	if r.pin.moves(r.current) && len(r.pin.fixed) > 0 {
		r.bump = r.pin.target.tag.raw
	}
}

type ShippedReport struct {
	results []shippedResult
}

func CheckShipped(root string) (ShippedReport, error) {
	return checkShipped(root, liveShippedSources())
}

func checkShipped(root string, src shippedSources) (ShippedReport, error) {
	components, err := shippedComponents(root)
	if err != nil {
		return ShippedReport{}, err
	}
	var report ShippedReport
	for _, c := range components {
		report.results = append(report.results, checkComponent(src, c))
	}
	return report, nil
}

func (r ShippedReport) Status() int {
	unreachable := false
	for _, result := range r.results {
		if result.needsYou() {
			return ShippedNeedsYou
		}
		if result.err != nil {
			unreachable = true
		}
	}
	if unreachable {
		return ShippedUnreachable
	}
	return ShippedClean
}

func (r shippedResult) displayed() []string {
	present := map[string]bool{}
	for _, id := range r.ids {
		present[id] = true
	}
	var out []string
	for _, id := range r.ids {
		folded := false
		if !strings.HasPrefix(id, "GHSA-") {
			for _, alias := range r.details[id].aliases {
				if strings.HasPrefix(alias, "GHSA-") && present[alias] {
					folded = true
				}
			}
		}
		if !folded {
			out = append(out, id)
		}
	}
	return out
}

func (r shippedResult) aliasesOf(id string) []string {
	var out []string
	for _, other := range r.ids {
		if other == id {
			continue
		}
		for _, alias := range r.details[other].aliases {
			if alias == id {
				out = append(out, other)
			}
		}
	}
	return out
}

func (r shippedResult) fixedIn() []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range r.ids {
		for _, v := range r.details[id].fixed {
			if !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	sortVersions(out)
	return out
}

func (r shippedResult) target(d decision) string {
	if r.component.addon != nil {
		return r.component.name + " " + d.target.tag.raw
	}
	return d.target.tag.raw
}

func (r shippedResult) personReason(to imageTag) string {
	from := r.current.tag
	switch {
	case from.major != to.major:
		return "a new major version"
	case r.component.patchOnly:
		return fmt.Sprintf("a new minor version, and %s takes patches only (%s)", r.component.name, r.component.why)
	}
	return fmt.Sprintf("a new minor version below 1.0, and %s is not a standalone tool (%s)", r.component.name, r.component.why)
}

func (r shippedResult) onHosts() string {
	fixedAll := len(r.host.unfixed) == 0 && len(r.host.fixed) > 0
	switch {
	case fixedAll:
		return "orchardctl update moves to " + r.target(r.host) + " on its own"
	case len(r.host.fixed) > 0:
		return fmt.Sprintf("orchardctl update moves to %s, which fixes %s. The rest needs a person.", r.target(r.host), strings.Join(r.host.fixed, ", "))
	case len(r.pin.fixed) > 0:
		return fmt.Sprintf("needs a person: %s fixes it, and is %s", r.target(r.pin), r.personReason(r.pin.target.tag))
	}
	return "no release fixes it yet"
}

func (r shippedResult) todo() string {
	var parts []string
	if r.bump != "" {
		where := r.component.setting
		if where == "" {
			where = "a --version pin for " + r.component.name
		}
		parts = append(parts, fmt.Sprintf("set %s in %s to %s", where, r.component.file, r.bump))
	}
	if len(r.pin.unfixed) > 0 {
		parts = append(parts, fmt.Sprintf("no release fixes %s yet: read the advisory and decide whether Orchard is exposed", strings.Join(r.pin.unfixed, ", ")))
	}
	if r.component.addon != nil && r.component.pin == "" {
		parts = append(parts, "new installs take the newest chart")
	}
	return strings.Join(parts, "; ")
}

func (r shippedResult) state() string {
	switch {
	case r.err != nil:
		return "could not check: " + r.err.Error()
	case r.skipped != "":
		return "not checked: " + r.skipped
	case len(r.ids) == 0:
		return "no known advisories"
	}
	return "needs you"
}

func osvLink(id string) string {
	return "https://osv.dev/vulnerability/" + url.PathEscape(id)
}

func (r ShippedReport) Text() string {
	var b strings.Builder
	for _, result := range r.results {
		fmt.Fprintf(&b, "%-34s %-24s %s\n", result.component.name, cmp.Or(result.shipped, "-"), result.state())
	}
	for _, result := range r.results {
		if !result.needsYou() {
			continue
		}
		fmt.Fprintf(&b, "\n%s %s (%s)\n", result.component.name, result.shipped, result.component.file)
		for _, id := range result.displayed() {
			d := result.details[id]
			line := fmt.Sprintf("  %s", id)
			if aliases := result.aliasesOf(id); len(aliases) > 0 {
				line += " (" + strings.Join(aliases, ", ") + ")"
			}
			if d.severity != "" {
				line += " " + d.severity
			}
			if len(d.fixed) > 0 {
				line += ", fixed in " + strings.Join(d.fixed, ", ")
			}
			if d.summary != "" {
				line += ": " + d.summary
			}
			fmt.Fprintf(&b, "%s\n    %s\n", line, osvLink(id))
		}
		fmt.Fprintf(&b, "  on hosts: %s\n", result.onHosts())
		fmt.Fprintf(&b, "  to do: %s\n", result.todo())
	}
	return b.String()
}

func markdownCell(s string) string {
	return strings.NewReplacer("|", `\|`, "\n", " ").Replace(s)
}

func (r ShippedReport) Markdown() string {
	var b strings.Builder
	b.WriteString("## Advisories in shipped components\n\n")
	needs, unreachable := 0, 0
	for _, result := range r.results {
		if result.needsYou() {
			needs++
		} else if result.err != nil {
			unreachable++
		}
	}
	switch {
	case needs > 0:
		fmt.Fprintf(&b, "**%d shipped component(s) have advisories.** New installs start with these versions, so bump the pin.\n\n", needs)
	case unreachable > 0:
		fmt.Fprintf(&b, "**Could not check %d component(s).** OSV.dev, a registry or a chart repository did not answer.\n\n", unreachable)
	default:
		b.WriteString("No shipped component has a known advisory.\n\n")
	}
	if needs > 0 {
		b.WriteString("| Component | Shipped | Advisories | Fixed in | On hosts | What to do |\n|---|---|---|---|---|---|\n")
		for _, result := range r.results {
			if !result.needsYou() {
				continue
			}
			var advisories []string
			for _, id := range result.displayed() {
				d := result.details[id]
				cell := fmt.Sprintf("[%s](%s)", id, osvLink(id))
				if d.severity != "" {
					cell += " " + d.severity
				}
				if d.summary != "" {
					cell += ": " + d.summary
				}
				advisories = append(advisories, markdownCell(cell))
			}
			fixed := strings.Join(result.fixedIn(), ", ")
			if fixed == "" {
				fixed = "-"
			}
			fmt.Fprintf(&b, "| `%s` | `%s` | %s | %s | %s | %s |\n",
				result.component.name, result.shipped, strings.Join(advisories, "<br>"), markdownCell(fixed),
				markdownCell(result.onHosts()), markdownCell(result.todo()))
		}
		b.WriteString("\n")
	}
	b.WriteString("<details><summary>Every component</summary>\n\n| Component | File | Shipped | Result |\n|---|---|---|---|\n")
	for _, result := range r.results {
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` | %s |\n", result.component.name, result.component.file, result.shipped, markdownCell(result.state()))
	}
	b.WriteString("\n</details>\n")
	return b.String()
}
