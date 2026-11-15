package commands

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	defaultSoakDays = 7
	osvTimeout      = 20 * time.Second
	osvBatchLimit   = 1000
	userAgent       = "orchardctl"
)

var osvQueryBatchURL = "https://api.osv.dev/v1/querybatch"

type osvPackage struct {
	ecosystem   string
	name        string
	majorSuffix bool
}

func (p osvPackage) nameFor(version imageTag) string {
	if p.majorSuffix && version.major >= 2 {
		return p.name + "/v" + strconv.Itoa(version.major)
	}
	return p.name
}

func osvVersion(t imageTag) string {
	return fmt.Sprintf("%d.%d.%d", t.major, t.minor, t.patch)
}

func crossesMajor(from, to imageTag) bool {
	if from.major != to.major {
		return true
	}
	return from.major == 0 && from.minor != to.minor
}

func soakDuration(raw string) time.Duration {
	days := defaultSoakDays
	if raw = strings.TrimSpace(raw); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
			days = n
		}
	}
	return time.Duration(days) * 24 * time.Hour
}

type candidate struct {
	tag    imageTag
	app    imageTag
	hasApp bool
}

func imageCandidate(tag imageTag) candidate {
	return candidate{tag: tag, app: tag, hasApp: true}
}

type decision struct {
	target     candidate
	fixed      []string
	early      bool
	waiting    *candidate
	unfixed    []string
	later      *candidate
	laterFixes []string
}

func (d decision) moves(current candidate) bool {
	return d.target.tag.raw != current.tag.raw
}

func advisoriesOf(known map[string][]string, r candidate) ([]string, bool) {
	if known == nil || !r.hasApp {
		return nil, false
	}
	ids, ok := known[osvVersion(r.app)]
	return ids, ok
}

func decide(current candidate, candidates []candidate, soaked func(candidate) bool, known map[string][]string, ahead *candidate) decision {
	d := decision{target: current}
	running := map[string]bool{}
	if ids, ok := advisoriesOf(known, current); ok {
		for _, id := range ids {
			running[id] = true
		}
	}
	adds := func(r candidate) bool {
		ids, _ := advisoriesOf(known, r)
		for _, id := range ids {
			if !running[id] {
				return true
			}
		}
		return false
	}
	fixes := func(r candidate) []string {
		ids, ok := advisoriesOf(known, r)
		if !ok || len(running) == 0 {
			return nil
		}
		still := map[string]bool{}
		for _, id := range ids {
			still[id] = true
		}
		var out []string
		for id := range running {
			if !still[id] {
				out = append(out, id)
			}
		}
		sort.Strings(out)
		return out
	}

	for i := len(candidates) - 1; i >= 0; i-- {
		r := candidates[i]
		if adds(r) {
			continue
		}
		if soaked(r) {
			d.target = r
			break
		}
		if d.waiting == nil {
			d.waiting = &candidates[i]
		}
	}

	if len(running) > 0 {
		most := 0
		for _, r := range candidates {
			if n := len(fixes(r)); !adds(r) && n > most {
				most = n
			}
		}
		if most > 0 && len(fixes(d.target)) < most {
			found := false
			for i := len(candidates) - 1; i >= 0 && !found; i-- {
				r := candidates[i]
				if !adds(r) && len(fixes(r)) == most && soaked(r) {
					d.target, found = r, true
				}
			}
			for i := 0; i < len(candidates) && !found; i++ {
				r := candidates[i]
				if !adds(r) && len(fixes(r)) == most {
					d.target, d.early, found = r, true, true
				}
			}
		}
		d.fixed = fixes(d.target)
		fixed := map[string]bool{}
		for _, id := range d.fixed {
			fixed[id] = true
		}
		for id := range running {
			if !fixed[id] {
				d.unfixed = append(d.unfixed, id)
			}
		}
		sort.Strings(d.unfixed)
		if len(d.unfixed) > 0 && ahead != nil {
			if ids, ok := advisoriesOf(known, *ahead); ok {
				in := map[string]bool{}
				for _, id := range ids {
					in[id] = true
				}
				for _, id := range d.unfixed {
					if !in[id] {
						d.laterFixes = append(d.laterFixes, id)
					}
				}
				if len(d.laterFixes) > 0 {
					d.later = ahead
				}
			}
		}
	}
	if d.waiting != nil && !d.waiting.tag.newerThan(d.target.tag) {
		d.waiting = nil
	}
	return d
}

func advisoryList(ids []string) (string, string) {
	verb := "affects"
	if len(ids) > 1 {
		verb = "affect"
	}
	if len(ids) > 3 {
		return fmt.Sprintf("%s and %d more", strings.Join(ids[:3], ", "), len(ids)-3), verb
	}
	return strings.Join(ids, ", "), verb
}

func (d decision) messages(current candidate, name func(candidate) string, soak time.Duration) (notes, warnings []string) {
	if d.moves(current) && len(d.fixed) > 0 {
		ids, verb := advisoryList(d.fixed)
		if d.early {
			notes = append(notes, fmt.Sprintf("security update: %s %s %s, moving to %s", ids, verb, name(current), name(d.target)))
		} else {
			notes = append(notes, fmt.Sprintf("%s has been public for %d days and fixes %s in %s", name(d.target), int(soak.Hours()/24), ids, name(current)))
		}
	}
	if d.waiting != nil {
		notes = append(notes, fmt.Sprintf("%s is out and waits until it has been public for %d days", name(*d.waiting), int(soak.Hours()/24)))
	}
	if len(d.unfixed) > 0 {
		subject := name(current)
		if d.moves(current) {
			subject = name(d.target)
		}
		ids, verb := advisoryList(d.unfixed)
		if d.later != nil {
			fixes, _ := advisoryList(d.laterFixes)
			warnings = append(warnings, fmt.Sprintf("note: %s %s %s. %s fixes %s and needs a person.", ids, verb, subject, name(*d.later), fixes))
		} else {
			warnings = append(warnings, fmt.Sprintf("note: %s %s %s, and no release that installs on its own fixes it yet.", ids, verb, subject))
		}
	}
	return notes, warnings
}

type osvClient struct {
	http *http.Client
	url  string
}

func newOSVClient() *osvClient {
	return &osvClient{http: &http.Client{Timeout: osvTimeout}, url: osvQueryBatchURL}
}

type osvQuery struct {
	Package struct {
		Ecosystem string `json:"ecosystem"`
		Name      string `json:"name"`
	} `json:"package"`
	Version string `json:"version"`
}

func (o *osvClient) advisories(pkgs []osvPackage, versions []imageTag) (map[string][]string, error) {
	var queries []osvQuery
	var keys []string
	known := map[string][]string{}
	seen := map[string]bool{}
	for _, v := range versions {
		key := osvVersion(v)
		if seen[key] {
			continue
		}
		seen[key] = true
		known[key] = nil
		for _, p := range pkgs {
			var q osvQuery
			q.Package.Ecosystem = p.ecosystem
			q.Package.Name = p.nameFor(v)
			q.Version = key
			queries = append(queries, q)
			keys = append(keys, key)
		}
	}
	ids := map[string]map[string]bool{}
	for start := 0; start < len(queries); start += osvBatchLimit {
		end := min(start+osvBatchLimit, len(queries))
		results, err := o.batch(queries[start:end])
		if err != nil {
			return nil, err
		}
		for i, vulns := range results {
			key := keys[start+i]
			if ids[key] == nil {
				ids[key] = map[string]bool{}
			}
			for _, id := range vulns {
				ids[key][id] = true
			}
		}
	}
	for key, set := range ids {
		list := make([]string, 0, len(set))
		for id := range set {
			list = append(list, id)
		}
		sort.Strings(list)
		known[key] = list
	}
	return known, nil
}

func (o *osvClient) batch(queries []osvQuery) ([][]string, error) {
	body, err := json.Marshal(map[string]any{"queries": queries})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, o.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := o.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("api.osv.dev answered %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	var out struct {
		Results []struct {
			Vulns []struct {
				ID string `json:"id"`
			} `json:"vulns"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if len(out.Results) != len(queries) {
		return nil, fmt.Errorf("api.osv.dev answered %d results for %d queries", len(out.Results), len(queries))
	}
	results := make([][]string, len(out.Results))
	for i, r := range out.Results {
		for _, v := range r.Vulns {
			if v.ID != "" {
				results[i] = append(results[i], v.ID)
			}
		}
	}
	return results, nil
}

type updateGate struct {
	now    func() time.Time
	soak   time.Duration
	osv    *osvClient
	osvErr error
	warn   func(format string, a ...any)
}

var sharedGate *updateGate

func gateFor(c *cli.Context) *updateGate {
	if sharedGate == nil {
		sharedGate = &updateGate{now: time.Now, soak: soakDuration(c.Env.UpdateSoak), osv: newOSVClient(), warn: c.Warnf}
	}
	return sharedGate
}

func (g *updateGate) advisories(pkgs []osvPackage, releases ...candidate) map[string][]string {
	if len(pkgs) == 0 || g.osv == nil || g.osvErr != nil {
		return nil
	}
	var versions []imageTag
	for _, r := range releases {
		if r.hasApp {
			versions = append(versions, r.app)
		}
	}
	if len(versions) == 0 {
		return nil
	}
	known, err := g.osv.advisories(pkgs, versions)
	if err != nil {
		g.osvErr = err
		if g.warn != nil {
			g.warn("note: couldn't read security advisories from api.osv.dev (%s). Third-party updates wait for their soak.\n", err)
		}
		return nil
	}
	return known
}

func (g *updateGate) soaked(published func(candidate) (time.Time, error)) func(candidate) bool {
	cache := map[string]bool{}
	return func(r candidate) bool {
		if g.soak <= 0 {
			return true
		}
		if ok, seen := cache[r.tag.raw]; seen {
			return ok
		}
		at, err := published(r)
		now := g.now()
		ok := err == nil && at.Year() >= 2000 && !at.After(now) && now.Sub(at) >= g.soak
		cache[r.tag.raw] = ok
		return ok
	}
}

func (g *updateGate) plan(pkgs []osvPackage, current candidate, candidates []candidate, ahead *candidate, published func(candidate) (time.Time, error)) decision {
	all := append([]candidate{current}, candidates...)
	if ahead != nil {
		all = append(all, *ahead)
	}
	known := g.advisories(pkgs, all...)
	return decide(current, candidates, g.soaked(published), known, ahead)
}
