package commands

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const day = 24 * time.Hour

var fixedNow = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

func TestCrossesMajor(t *testing.T) {
	cases := []struct {
		from, to string
		crosses  bool
	}{
		{"1.4.0", "1.4.1", false},
		{"1.4.0", "1.9.0", false},
		{"1.4.0", "2.0.0", true},
		{"0.61.0", "0.61.3", false},
		{"0.61.0", "0.62.0", true},
		{"0.9.9", "1.0.0", true},
		{"v42.3.0", "v42.4.0", false},
		{"v42.3.0", "v43.0.0", true},
	}
	for _, tc := range cases {
		if got := crossesMajor(mustTag(t, tc.from), mustTag(t, tc.to)); got != tc.crosses {
			t.Errorf("%s to %s: got %v", tc.from, tc.to, got)
		}
	}
}

func TestSoakDuration(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 7 * day, "3": 3 * day, "0": 0, "-1": 7 * day, "soon": 7 * day, " 14 ": 14 * day} {
		if got := soakDuration(raw); got != want {
			t.Errorf("%q: got %s", raw, got)
		}
	}
}

func candidatesOf(t *testing.T, raws ...string) []candidate {
	out := make([]candidate, len(raws))
	for i, raw := range raws {
		out[i] = imageCandidate(mustTag(t, raw))
	}
	return out
}

func publishedOn(dates map[string]time.Time) func(candidate) (time.Time, error) {
	return func(r candidate) (time.Time, error) {
		if at, ok := dates[r.tag.raw]; ok {
			return at, nil
		}
		return time.Time{}, fmt.Errorf("no date for %s", r.tag.raw)
	}
}

func TestSoakPicksTheNewestReleaseThatHasWaited(t *testing.T) {
	gate := &updateGate{now: func() time.Time { return fixedNow }, soak: 7 * day}
	dates := map[string]time.Time{
		"1.4.1": fixedNow.Add(-30 * day),
		"1.4.2": fixedNow.Add(-8 * day),
		"1.4.3": fixedNow.Add(-6 * day),
	}
	d := gate.plan(nil, imageCandidate(mustTag(t, "1.4.0")), candidatesOf(t, "1.4.1", "1.4.2", "1.4.3", "1.4.4"), nil, publishedOn(dates))
	if d.target.tag.raw != "1.4.2" || d.early {
		t.Errorf("target %s early %v", d.target.tag.raw, d.early)
	}
	if d.waiting == nil || d.waiting.tag.raw != "1.4.4" {
		t.Errorf("waiting %v", d.waiting)
	}
}

func TestSoakTreatsAMissingOrImplausibleDateAsNotSoaked(t *testing.T) {
	gate := &updateGate{now: func() time.Time { return fixedNow }, soak: 7 * day}
	dates := map[string]time.Time{
		"1.4.1": time.Unix(0, 0),
		"1.4.2": fixedNow.Add(2 * day),
	}
	d := gate.plan(nil, imageCandidate(mustTag(t, "1.4.0")), candidatesOf(t, "1.4.1", "1.4.2", "1.4.3"), nil, publishedOn(dates))
	if d.moves(imageCandidate(mustTag(t, "1.4.0"))) {
		t.Errorf("moved to %s without a usable date", d.target.tag.raw)
	}
}

func TestSoakOfZeroTakesTheNewest(t *testing.T) {
	gate := &updateGate{now: func() time.Time { return fixedNow }}
	d := gate.plan(nil, imageCandidate(mustTag(t, "1.4.0")), candidatesOf(t, "1.4.1", "1.4.2"), nil, func(candidate) (time.Time, error) {
		t.Fatal("no date lookup with the soak off")
		return time.Time{}, nil
	})
	if d.target.tag.raw != "1.4.2" {
		t.Errorf("target %s", d.target.tag.raw)
	}
}

type fakeOSV struct {
	server  *httptest.Server
	calls   atomic.Int32
	queries []osvQuery
}

func newFakeOSV(t *testing.T, affected map[string][]string) *fakeOSV {
	f := &fakeOSV{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if r.Method != http.MethodPost || r.Header.Get("User-Agent") != userAgent {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var body struct {
			Queries []osvQuery `json:"queries"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.queries = append(f.queries, body.Queries...)
		type vuln struct {
			ID string `json:"id"`
		}
		type result struct {
			Vulns []vuln `json:"vulns,omitempty"`
		}
		out := struct {
			Results []result `json:"results"`
		}{}
		for _, q := range body.Queries {
			var res result
			for _, id := range affected[q.Package.Name+"@"+q.Version] {
				res.Vulns = append(res.Vulns, vuln{ID: id})
			}
			out.Results = append(out.Results, res)
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func gateWithOSV(url string) (*updateGate, *[]string) {
	var warnings []string
	gate := &updateGate{
		now:  func() time.Time { return fixedNow },
		soak: 7 * day,
		osv:  &osvClient{http: &http.Client{Timeout: 5 * time.Second}, url: url},
		warn: func(format string, a ...any) { warnings = append(warnings, fmt.Sprintf(format, a...)) },
	}
	return gate, &warnings
}

var trivyPkg = []osvPackage{{ecosystem: "Go", name: "github.com/aquasecurity/trivy"}}

func TestFastTrackLeavesAnAffectedVersionAtOnce(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/aquasecurity/trivy@0.69.4": {"GHSA-69fq-xp46-6x23"},
	})
	gate, warnings := gateWithOSV(osv.server.URL)
	dates := map[string]time.Time{"0.69.5": fixedNow.Add(-1 * day), "0.69.6": fixedNow.Add(-2 * time.Hour)}
	current := imageCandidate(mustTag(t, "0.69.4"))
	d := gate.plan(trivyPkg, current, candidatesOf(t, "0.69.5", "0.69.6"), nil, publishedOn(dates))
	if d.target.tag.raw != "0.69.5" || !d.early {
		t.Fatalf("target %s early %v", d.target.tag.raw, d.early)
	}
	notes, warns := d.messages(current, imageName("ghcr.io/aquasecurity/trivy"), gate.soak)
	if len(notes) == 0 || notes[0] != "security update: GHSA-69fq-xp46-6x23 affects ghcr.io/aquasecurity/trivy:0.69.4, moving to ghcr.io/aquasecurity/trivy:0.69.5" {
		t.Errorf("notes %q", notes)
	}
	if len(warns) != 0 || len(*warnings) != 0 {
		t.Errorf("warnings %q %q", warns, *warnings)
	}
	if osv.calls.Load() != 1 {
		t.Errorf("expected one batch call, got %d", osv.calls.Load())
	}
}

func TestFastTrackSkipsATargetThatIsAffectedToo(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/aquasecurity/trivy@0.69.3": {"GO-2026-6294"},
		"github.com/aquasecurity/trivy@0.69.4": {"GO-2026-6294", "GHSA-69fq-xp46-6x23"},
		"github.com/aquasecurity/trivy@0.69.5": {"GO-2026-6294"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	current := imageCandidate(mustTag(t, "0.69.3"))
	d := gate.plan(trivyPkg, current, candidatesOf(t, "0.69.4", "0.69.5", "0.69.6"), nil, publishedOn(nil))
	if d.target.tag.raw != "0.69.6" || !d.early || strings.Join(d.fixed, ",") != "GO-2026-6294" {
		t.Errorf("target %s early %v fixed %v", d.target.tag.raw, d.early, d.fixed)
	}
}

func TestFastTrackPrefersTheEarliestUnsoakedFix(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/aquasecurity/trivy@0.69.2": {"GHSA-a"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	dates := map[string]time.Time{"0.69.3": fixedNow.Add(-3 * day), "0.69.4": fixedNow.Add(-1 * time.Hour)}
	d := gate.plan(trivyPkg, imageCandidate(mustTag(t, "0.69.2")), candidatesOf(t, "0.69.3", "0.69.4"), nil, publishedOn(dates))
	if d.target.tag.raw != "0.69.3" || !d.early {
		t.Errorf("target %s early %v", d.target.tag.raw, d.early)
	}
}

func TestASoakedFixNeedsNoFastTrack(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/aquasecurity/trivy@0.69.2": {"GHSA-a"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	dates := map[string]time.Time{"0.69.3": fixedNow.Add(-20 * day), "0.69.4": fixedNow.Add(-9 * day), "0.69.5": fixedNow.Add(-1 * day)}
	d := gate.plan(trivyPkg, imageCandidate(mustTag(t, "0.69.2")), candidatesOf(t, "0.69.3", "0.69.4", "0.69.5"), nil, publishedOn(dates))
	if d.target.tag.raw != "0.69.4" || d.early || strings.Join(d.fixed, ",") != "GHSA-a" {
		t.Errorf("target %s early %v fixed %v", d.target.tag.raw, d.early, d.fixed)
	}
	notes, _ := d.messages(imageCandidate(mustTag(t, "0.69.2")), imageName("trivy"), gate.soak)
	if len(notes) == 0 || strings.HasPrefix(notes[0], "security update") || !strings.Contains(notes[0], "fixes GHSA-a") {
		t.Errorf("notes %q", notes)
	}
}

func TestAdvisoryList(t *testing.T) {
	if got, verb := advisoryList([]string{"A"}); got != "A" || verb != "affects" {
		t.Errorf("got %s %s", got, verb)
	}
	if got, verb := advisoryList([]string{"A", "B", "C", "D", "E"}); got != "A, B, C and 2 more" || verb != "affect" {
		t.Errorf("got %s %s", got, verb)
	}
}

func TestSoakSkipsAReleaseWithANewAdvisory(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/aquasecurity/trivy@0.69.4": {"GHSA-69fq-xp46-6x23"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	dates := map[string]time.Time{"0.69.3": fixedNow.Add(-20 * day), "0.69.4": fixedNow.Add(-9 * day)}
	d := gate.plan(trivyPkg, imageCandidate(mustTag(t, "0.69.2")), candidatesOf(t, "0.69.3", "0.69.4"), nil, publishedOn(dates))
	if d.target.tag.raw != "0.69.3" {
		t.Errorf("moved to an affected release: %s", d.target.tag.raw)
	}
}

func TestAnUnfixedAdvisoryPointsAtTheNextMajor(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/aquasecurity/trivy@0.69.3": {"GO-2026-6294"},
		"github.com/aquasecurity/trivy@0.69.4": {"GO-2026-6294"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	current := imageCandidate(mustTag(t, "0.69.3"))
	ahead := imageCandidate(mustTag(t, "0.71.1"))
	d := gate.plan(trivyPkg, current, candidatesOf(t, "0.69.4"), &ahead, publishedOn(map[string]time.Time{"0.69.4": fixedNow.Add(-30 * day)}))
	_, warns := d.messages(current, imageName("trivy"), gate.soak)
	if len(warns) != 1 || !strings.Contains(warns[0], "GO-2026-6294 affects trivy:0.69.4. trivy:0.71.1 fixes GO-2026-6294 and needs a person.") {
		t.Errorf("warnings %q", warns)
	}
}

func TestOSVDownFallsBackToTheSoak(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer down.Close()
	gate, warnings := gateWithOSV(down.URL)
	dates := map[string]time.Time{"0.69.5": fixedNow.Add(-9 * day), "0.69.6": fixedNow.Add(-1 * day)}
	d := gate.plan(trivyPkg, imageCandidate(mustTag(t, "0.69.4")), candidatesOf(t, "0.69.5", "0.69.6"), nil, publishedOn(dates))
	if d.target.tag.raw != "0.69.5" || d.early || len(d.fixed) != 0 {
		t.Errorf("target %s early %v fixed %v", d.target.tag.raw, d.early, d.fixed)
	}
	if len(*warnings) != 1 || !strings.Contains((*warnings)[0], "api.osv.dev") {
		t.Errorf("warnings %q", *warnings)
	}
	gate.plan(trivyPkg, imageCandidate(mustTag(t, "0.69.4")), nil, nil, publishedOn(nil))
	if len(*warnings) != 1 {
		t.Errorf("OSV.dev should be tried once a run: %q", *warnings)
	}

	gate, _ = gateWithOSV("http://127.0.0.1:1")
	d = gate.plan(trivyPkg, imageCandidate(mustTag(t, "0.69.4")), candidatesOf(t, "0.69.5", "0.69.6"), nil, publishedOn(dates))
	if d.target.tag.raw != "0.69.5" || d.early {
		t.Errorf("unreachable: target %s early %v", d.target.tag.raw, d.early)
	}
}

func TestOSVQueriesUseTheModuleForTheMajorVersion(t *testing.T) {
	osv := newFakeOSV(t, map[string][]string{
		"github.com/traefik/traefik/v3@3.7.17": {"GHSA-t"},
	})
	gate, _ := gateWithOSV(osv.server.URL)
	pkgs := []osvPackage{{ecosystem: "Go", name: "github.com/traefik/traefik", majorSuffix: true}}
	current := candidate{tag: mustTag(t, "42.3.0"), app: mustTag(t, "v3.7.17"), hasApp: true}
	next := candidate{tag: mustTag(t, "42.3.1"), app: mustTag(t, "v3.7.18"), hasApp: true}
	d := gate.plan(pkgs, current, []candidate{next}, nil, publishedOn(nil))
	if d.target.tag.raw != "42.3.1" || !d.early {
		t.Errorf("target %s early %v", d.target.tag.raw, d.early)
	}
	for _, q := range osv.queries {
		if q.Package.Name != "github.com/traefik/traefik/v3" || q.Package.Ecosystem != "Go" || strings.HasPrefix(q.Version, "v") {
			t.Errorf("query %+v", q)
		}
	}
}

func TestDockerHubAndQuayPushTimes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/namespaces/library/repositories/redis/tags/8.10.4-alpine":
			fmt.Fprint(w, `{"name":"8.10.4-alpine","last_updated":"2026-11-12T00:00:00Z","tag_last_pushed":"2026-11-11T21:05:10.84239Z"}`)
		case "/api/v1/repository/skopeo/stable/tag/":
			if r.URL.Query().Get("specificTag") != "v1.24.1" {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, `{"tags":[{"name":"v1.24.1","start_ts":1794540515}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := &registryClient{http: server.Client(), hubAPI: server.URL, quayAPI: server.URL}
	at, err := client.published("redis", "8.10.4-alpine")
	if err != nil || !at.Equal(time.Date(2026, 11, 11, 21, 5, 10, 842390000, time.UTC)) {
		t.Errorf("docker hub: %s %v", at, err)
	}
	at, err = client.published("quay.io/skopeo/stable", "v1.24.1")
	if err != nil || at.Unix() != 1794540515 {
		t.Errorf("quay: %s %v", at, err)
	}
	if _, err := client.published("redis", "9.9.9"); err == nil {
		t.Error("a missing tag should have no date")
	}
}

func TestConfigCreatedReadsThePlatformImage(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/aquasecurity/trivy/manifests/0.76.2":
			fmt.Fprint(w, `{"manifests":[{"digest":"sha256:arm","platform":{"os":"linux","architecture":"arm64"}},{"digest":"sha256:amd","platform":{"os":"linux","architecture":"amd64"}}]}`)
		case "/v2/aquasecurity/trivy/manifests/sha256:amd":
			fmt.Fprint(w, `{"config":{"digest":"sha256:cfg"}}`)
		case "/v2/aquasecurity/trivy/blobs/sha256:cfg":
			fmt.Fprint(w, `{"created":"2026-11-05T12:48:01.083417393Z"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "https://")
	client := &registryClient{http: server.Client()}
	at, err := client.published(host+"/aquasecurity/trivy", "0.76.2")
	if err != nil || !at.Equal(time.Date(2026, 11, 5, 12, 48, 1, 83417393, time.UTC)) {
		t.Errorf("got %s %v", at, err)
	}
}
