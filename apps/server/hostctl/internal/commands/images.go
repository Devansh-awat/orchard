package commands

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

type bundledImage struct {
	path               string
	patchOnly          bool
	securityCrossMinor bool
	why                string
	osv                []osvPackage
}

var (
	osvRedis       = []osvPackage{{ecosystem: "GIT", name: "https://github.com/redis/redis"}}
	osvBuildKit    = []osvPackage{{ecosystem: "Go", name: "github.com/moby/buildkit"}}
	osvVictoria    = []osvPackage{{ecosystem: "Go", name: "github.com/VictoriaMetrics/VictoriaMetrics"}}
	osvAWSCLI      = []osvPackage{{ecosystem: "GIT", name: "https://github.com/aws/aws-cli"}}
	osvZot         = []osvPackage{{ecosystem: "Go", name: "zotregistry.dev/zot", majorSuffix: true}}
	osvCloudflared = []osvPackage{{ecosystem: "GIT", name: "https://github.com/cloudflare/cloudflared"}}
)

var bundledImages = []bundledImage{
	{path: "redis.image", patchOnly: true, osv: osvRedis,
		why: "holds data on a volume: the event streams and the cache"},
	{path: "postgres.pooler.image", patchOnly: true,
		why: "sits in front of every database connection"},
	{path: "builders.buildkitImage", patchOnly: true, osv: osvBuildKit,
		why: "a minor version can change the build cache format and the build API"},
	{path: "builders.buildkitRootlessImage", patchOnly: true, osv: osvBuildKit,
		why: "a minor version can change the build cache format and the build API"},
	{path: "builderSandbox.pusherImage", securityCrossMinor: true, osv: []osvPackage{{ecosystem: "Go", name: "github.com/containers/skopeo"}},
		why: "copies an image and exits, and keeps nothing"},
	{path: "metrics.victoriametrics.image", osv: osvVictoria,
		why: "holds data: the metrics store"},
	{path: "metrics.vmagent.image", securityCrossMinor: true, osv: osvVictoria,
		why: "scrapes and forwards metrics, and keeps nothing it can't rebuild"},
	{path: "metrics.kubeStateMetrics.image", securityCrossMinor: true, osv: []osvPackage{{ecosystem: "Go", name: "k8s.io/kube-state-metrics", majorSuffix: true}},
		why: "reads the cluster and serves metrics, and keeps nothing"},
	{path: "metrics.nodeExporter.image", securityCrossMinor: true, osv: []osvPackage{{ecosystem: "Go", name: "github.com/prometheus/node_exporter"}},
		why: "reads the host and serves metrics, and keeps nothing"},
	{path: "logs.victorialogs.image",
		why: "holds data: the log store"},
	{path: "logs.vector.image", securityCrossMinor: true, osv: []osvPackage{{ecosystem: "GIT", name: "https://github.com/vectordotdev/vector"}},
		why: "ships logs and keeps only its read positions, and a version that rejects its configuration does not come up and is rolled back"},
	{path: "trivy.image", securityCrossMinor: true, osv: []osvPackage{{ecosystem: "Go", name: "github.com/aquasecurity/trivy"}},
		why: "scans an image and exits, and downloads the database its version reads"},
	{path: "objectStorage.local.image", osv: []osvPackage{{ecosystem: "Go", name: "github.com/versity/versitygw"}},
		why: "holds data: the object store"},
	{path: "objectStorage.local.bucketImage", securityCrossMinor: true, osv: osvAWSCLI,
		why: "creates a bucket and exits"},
	{path: "databaseDumps.uploaderImage", securityCrossMinor: true, osv: osvAWSCLI,
		why: "uploads a dump and exits"},
}

type floatingWorkload struct {
	namespace          string
	name               string
	repo               string
	anyMajor           bool
	securityCrossMinor bool
	why                string
	osv                []osvPackage
}

var floatingWorkloads = []floatingWorkload{
	{namespace: "orchard", name: "zot", repo: "ghcr.io/project-zot/zot", osv: osvZot,
		why: "holds data: every image Orchard builds"},
	{namespace: "cloudflared", name: "cloudflared", repo: "cloudflare/cloudflared", anyMajor: true, securityCrossMinor: true, osv: osvCloudflared,
		why: "forwards traffic and keeps nothing"},
}

const (
	imagesFileName    = "images.yaml"
	heldFileName      = "images-held"
	imageReadyWait    = 3 * time.Minute
	imageFirstPodWait = 30 * time.Second
	registryTimeout   = 30 * time.Second
	maxTagPages       = 200
)

var imageTagPattern = regexp.MustCompile(`^(v?)(\d+)\.(\d+)\.(\d+)(-[A-Za-z0-9.-]+)?$`)

type imageTag struct {
	raw                 string
	prefix              string
	major, minor, patch int
	suffix              string
}

func parseImageTag(raw string) (imageTag, bool) {
	m := imageTagPattern.FindStringSubmatch(raw)
	if m == nil {
		return imageTag{}, false
	}
	n := func(i int) int {
		v, _ := strconv.Atoi(m[i])
		return v
	}
	return imageTag{raw: raw, prefix: m[1], major: n(2), minor: n(3), patch: n(4), suffix: m[5]}, true
}

func (t imageTag) newerThan(o imageTag) bool {
	for _, pair := range [][2]int{{t.major, o.major}, {t.minor, o.minor}, {t.patch, o.patch}} {
		if pair[0] != pair[1] {
			return pair[0] > pair[1]
		}
	}
	return false
}

func splitImage(image string) (repo, tag string, ok bool) {
	ref, _, _ := strings.Cut(image, "@")
	i := strings.LastIndex(ref, ":")
	if i < 0 || strings.Contains(ref[i:], "/") {
		return "", "", false
	}
	return ref[:i], ref[i+1:], true
}

func pinnedRef(repo, tag, digest string) string {
	return repo + ":" + tag + "@" + digest
}

func imageCandidates(current imageTag, tags []string, patchOnly, anyMajor, securityCrossMinor bool, held map[string]bool, repo string) (candidates []candidate, ahead *imageTag) {
	for _, raw := range tags {
		tag, ok := parseImageTag(raw)
		if !ok || tag.prefix != current.prefix || tag.suffix != current.suffix || !tag.newerThan(current) {
			continue
		}
		reachable, securityOnly := true, false
		if !anyMajor {
			reachable, securityOnly = reaches(current, tag, securityCrossMinor)
		}
		if patchOnly && tag.minor != current.minor {
			reachable = false
		}
		if !reachable || securityOnly {
			if ahead == nil || tag.newerThan(*ahead) {
				ahead = &tag
			}
		}
		if !reachable || held[repo+":"+raw] {
			continue
		}
		next := imageCandidate(tag)
		next.securityOnly = securityOnly
		candidates = append(candidates, next)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[j].tag.newerThan(candidates[i].tag) })
	return candidates, ahead
}

func planImage(gate *updateGate, pkgs []osvPackage, repo string, current imageTag, candidates []candidate, ahead *imageTag, published func(repo, tag string) (time.Time, error)) decision {
	var beyond *candidate
	if ahead != nil {
		r := imageCandidate(*ahead)
		beyond = &r
	}
	return gate.plan(pkgs, imageCandidate(current), candidates, beyond, func(r candidate) (time.Time, error) {
		return published(repo, r.tag.raw)
	})
}

func imageName(repo string) func(candidate) string {
	return func(r candidate) string { return repo + ":" + r.tag.raw }
}

func registryRef(repo string) (host, path string) {
	first, rest, found := strings.Cut(repo, "/")
	if found && strings.ContainsAny(first, ".:") {
		host, path = first, rest
	} else {
		host, path = "docker.io", repo
	}
	if host == "docker.io" {
		host = "registry-1.docker.io"
		if !strings.Contains(path, "/") {
			path = "library/" + path
		}
	}
	return host, path
}

var challengeParam = regexp.MustCompile(`([a-zA-Z]+)="([^"]*)"`)

func tokenURLFromChallenge(challenge string) (string, error) {
	if !strings.HasPrefix(strings.ToLower(challenge), "bearer ") {
		return "", fmt.Errorf("unexpected auth challenge %q", challenge)
	}
	params := map[string]string{}
	for _, m := range challengeParam.FindAllStringSubmatch(challenge, -1) {
		params[strings.ToLower(m[1])] = m[2]
	}
	if params["realm"] == "" {
		return "", errors.New("auth challenge names no realm")
	}
	u, err := url.Parse(params["realm"])
	if err != nil {
		return "", err
	}
	q := u.Query()
	for _, key := range []string{"service", "scope"} {
		if params[key] != "" {
			q.Set(key, params[key])
		}
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

var nextLink = regexp.MustCompile(`<([^>]+)>;\s*rel="?next"?`)

func nextPage(host, link string) string {
	m := nextLink.FindStringSubmatch(link)
	if m == nil {
		return ""
	}
	if strings.HasPrefix(m[1], "/") {
		return "https://" + host + m[1]
	}
	return m[1]
}

type registryClient struct {
	http    *http.Client
	hubAPI  string
	quayAPI string
}

func newRegistryClient() *registryClient {
	return &registryClient{http: &http.Client{Timeout: registryTimeout}, hubAPI: "https://hub.docker.com", quayAPI: "https://quay.io"}
}

func (r *registryClient) get(target string, out any) error {
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := r.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", req.URL.Host, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

func (r *registryClient) token(challenge string) (string, error) {
	tokenURL, err := tokenURLFromChallenge(challenge)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodGet, tokenURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := r.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token request answered %d", res.StatusCode)
	}
	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.Token != "" {
		return body.Token, nil
	}
	return body.AccessToken, nil
}

func (r *registryClient) do(method, target, bearer string, accept string) (*http.Response, string, error) {
	send := func(token string) (*http.Response, error) {
		req, err := http.NewRequest(method, target, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", userAgent)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		return r.http.Do(req)
	}
	res, err := send(bearer)
	if err != nil {
		return nil, bearer, err
	}
	if res.StatusCode == http.StatusUnauthorized {
		challenge := res.Header.Get("WWW-Authenticate")
		res.Body.Close()
		token, err := r.token(challenge)
		if err != nil {
			return nil, bearer, err
		}
		res, err = send(token)
		if err != nil {
			return nil, token, err
		}
		return res, token, nil
	}
	return res, bearer, nil
}

func (r *registryClient) tags(repo string) ([]string, error) {
	host, path := registryRef(repo)
	target := fmt.Sprintf("https://%s/v2/%s/tags/list?n=1000", host, path)
	bearer := ""
	var all []string
	for page := 0; target != "" && page < maxTagPages; page++ {
		res, token, err := r.do(http.MethodGet, target, bearer, "")
		if err != nil {
			return nil, err
		}
		bearer = token
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return nil, fmt.Errorf("%s answered %d", host, res.StatusCode)
		}
		var body struct {
			Tags []string `json:"tags"`
		}
		err = json.NewDecoder(res.Body).Decode(&body)
		link := res.Header.Get("Link")
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		all = append(all, body.Tags...)
		target = nextPage(host, link)
	}
	return all, nil
}

const manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

func (r *registryClient) digest(repo, tag string) (string, error) {
	host, path := registryRef(repo)
	target := fmt.Sprintf("https://%s/v2/%s/manifests/%s", host, path, tag)
	res, _, err := r.do(http.MethodHead, target, "", manifestAccept)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %d", host, res.StatusCode)
	}
	digest := res.Header.Get("Docker-Content-Digest")
	if digest == "" {
		return "", errors.New("no digest in the response")
	}
	return digest, nil
}

func (r *registryClient) published(repo, tag string) (time.Time, error) {
	host, path := registryRef(repo)
	switch host {
	case "registry-1.docker.io":
		return r.dockerHubPushed(path, tag)
	case "quay.io":
		return r.quayPushed(path, tag)
	}
	return r.configCreated(host, path, tag)
}

func (r *registryClient) dockerHubPushed(path, tag string) (time.Time, error) {
	namespace, name, ok := strings.Cut(path, "/")
	if !ok {
		return time.Time{}, fmt.Errorf("unexpected Docker Hub repository %q", path)
	}
	var body struct {
		TagLastPushed string `json:"tag_last_pushed"`
		LastUpdated   string `json:"last_updated"`
	}
	target := fmt.Sprintf("%s/v2/namespaces/%s/repositories/%s/tags/%s", r.hubAPI, url.PathEscape(namespace), url.PathEscape(name), url.PathEscape(tag))
	if err := r.get(target, &body); err != nil {
		return time.Time{}, err
	}
	pushed := body.TagLastPushed
	if pushed == "" {
		pushed = body.LastUpdated
	}
	return time.Parse(time.RFC3339Nano, pushed)
}

func (r *registryClient) quayPushed(path, tag string) (time.Time, error) {
	var body struct {
		Tags []struct {
			Name    string `json:"name"`
			StartTS int64  `json:"start_ts"`
		} `json:"tags"`
	}
	target := fmt.Sprintf("%s/api/v1/repository/%s/tag/?specificTag=%s&onlyActiveTags=true", r.quayAPI, path, url.QueryEscape(tag))
	if err := r.get(target, &body); err != nil {
		return time.Time{}, err
	}
	for _, t := range body.Tags {
		if t.Name == tag && t.StartTS > 0 {
			return time.Unix(t.StartTS, 0).UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("quay.io has no push time for %s", tag)
}

func (r *registryClient) registryJSON(host, path, ref, kind, accept string, out any) error {
	target := fmt.Sprintf("https://%s/v2/%s/%s/%s", host, path, kind, ref)
	res, _, err := r.do(http.MethodGet, target, "", accept)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", host, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

type imageManifest struct {
	Manifests []struct {
		Digest   string `json:"digest"`
		Platform struct {
			OS           string `json:"os"`
			Architecture string `json:"architecture"`
		} `json:"platform"`
	} `json:"manifests"`
	Config struct {
		Digest string `json:"digest"`
	} `json:"config"`
}

func platformManifest(m imageManifest) string {
	for _, entry := range m.Manifests {
		if entry.Platform.OS == "linux" && entry.Platform.Architecture == "amd64" {
			return entry.Digest
		}
	}
	for _, entry := range m.Manifests {
		if entry.Platform.OS != "unknown" {
			return entry.Digest
		}
	}
	return ""
}

func (r *registryClient) configCreated(host, path, tag string) (time.Time, error) {
	var manifest imageManifest
	if err := r.registryJSON(host, path, tag, "manifests", manifestAccept, &manifest); err != nil {
		return time.Time{}, err
	}
	if len(manifest.Manifests) > 0 {
		digest := platformManifest(manifest)
		if digest == "" {
			return time.Time{}, errors.New("the image index lists no platform image")
		}
		manifest = imageManifest{}
		if err := r.registryJSON(host, path, digest, "manifests", manifestAccept, &manifest); err != nil {
			return time.Time{}, err
		}
	}
	if manifest.Config.Digest == "" {
		return time.Time{}, errors.New("the image has no config")
	}
	var config struct {
		Created string `json:"created"`
	}
	if err := r.registryJSON(host, path, manifest.Config.Digest, "blobs", "", &config); err != nil {
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339Nano, config.Created)
}

func imagesPath(c *cli.Context) string {
	return filepath.Join(c.Env.StateDir, imagesFileName)
}

func heldPath(c *cli.Context) string {
	return filepath.Join(c.Env.StateDir, heldFileName)
}

func parseHeld(raw string) map[string]bool {
	held := map[string]bool{}
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			held[line] = true
		}
	}
	return held
}

func readHeld(c *cli.Context) map[string]bool {
	raw, err := os.ReadFile(heldPath(c))
	if err != nil {
		return map[string]bool{}
	}
	return parseHeld(string(raw))
}

func appendHeld(c *cli.Context, image string) error {
	file, err := os.OpenFile(heldPath(c), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = fmt.Fprintln(file, image)
	return err
}

func chartValueArgs(c *cli.Context) []string {
	var args []string
	if _, err := os.Stat(imagesPath(c)); err == nil {
		args = append(args, "-f", imagesPath(c))
	}
	return append(args, "-f", c.Env.Values)
}

func loadOrEmptyValues(path string) (*cli.Values, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			return nil, err
		}
	}
	return cli.LoadValues(path)
}

type imageReport struct {
	path     string
	running  string
	chosen   string
	ahead    string
	pinned   bool
	err      error
	notes    []string
	warnings []string
}

type registryLookups struct {
	tags      func(repo string) ([]string, error)
	digest    func(repo, tag string) (string, error)
	published func(repo, tag string) (time.Time, error)
}

func imageAt(values *cli.Values, path string) string {
	if values == nil {
		return ""
	}
	s, _ := values.Get(path).(string)
	return s
}

func reportImage(entry bundledImage, chart, user, pinnedFile *cli.Values, lookups registryLookups, held map[string]bool, gate *updateGate) imageReport {
	report := imageReport{path: entry.path}
	if pinned := imageAt(user, entry.path); pinned != "" {
		report.running, report.chosen, report.pinned = pinned, pinned, true
		return report
	}
	floor := imageAt(chart, entry.path)
	if floor == "" {
		return report
	}
	report.running, report.chosen = floor, floor
	repo, rawTag, ok := splitImage(floor)
	if !ok {
		return report
	}
	current, ok := parseImageTag(rawTag)
	if !ok {
		return report
	}
	if previous := imageAt(pinnedFile, entry.path); previous != "" {
		if prevRepo, prevRaw, ok := splitImage(previous); ok && prevRepo == repo {
			if tag, ok := parseImageTag(prevRaw); ok && tag.newerThan(current) {
				current = tag
				report.running = previous
				report.chosen = previous
			}
		}
	}
	tags, err := lookups.tags(repo)
	if err != nil {
		report.err = err
		return report
	}
	candidates, ahead := imageCandidates(current, tags, entry.patchOnly, false, entry.securityCrossMinor, held, repo)
	if ahead != nil {
		report.ahead = repo + ":" + ahead.raw
	}
	plan := planImage(gate, entry.osv, repo, current, candidates, ahead, lookups.published)
	report.notes, report.warnings = plan.messages(imageCandidate(current), imageName(repo), gate.soak)
	best := plan.target.tag
	if best.raw == current.raw && strings.Contains(report.chosen, "@") {
		return report
	}
	digest, err := lookups.digest(repo, best.raw)
	if err != nil {
		report.err = err
		return report
	}
	report.chosen = pinnedRef(repo, best.raw, digest)
	return report
}

func imageReports(c *cli.Context) ([]imageReport, *cli.Values, *cli.Values, error) {
	chartYAML, err := c.Capture("helm", "show", "values", c.Env.Chart)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("couldn't read the chart defaults: %w", err)
	}
	chart, err := cli.ParseValues([]byte(chartYAML))
	if err != nil {
		return nil, nil, nil, err
	}
	user, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return nil, nil, nil, err
	}
	pinnedFile, err := loadOrEmptyValues(imagesPath(c))
	if err != nil {
		return nil, nil, nil, err
	}
	client := newRegistryClient()
	cache := map[string][]string{}
	tagsFor := func(repo string) ([]string, error) {
		if tags, ok := cache[repo]; ok {
			return tags, nil
		}
		tags, err := client.tags(repo)
		if err == nil {
			cache[repo] = tags
		}
		return tags, err
	}
	pushed := map[string]time.Time{}
	publishedFor := func(repo, tag string) (time.Time, error) {
		if at, ok := pushed[repo+":"+tag]; ok {
			return at, nil
		}
		at, err := client.published(repo, tag)
		if err == nil {
			pushed[repo+":"+tag] = at
		}
		return at, err
	}
	lookups := registryLookups{tags: tagsFor, digest: client.digest, published: publishedFor}
	held := readHeld(c)
	gate := gateFor(c)
	reports := make([]imageReport, 0, len(bundledImages))
	for _, entry := range bundledImages {
		reports = append(reports, reportImage(entry, chart, user, pinnedFile, lookups, held, gate))
	}
	return reports, chart, pinnedFile, nil
}

type imageChange struct {
	path     string
	previous string
	next     string
}

func refreshBundledImages(c *cli.Context) []imageChange {
	if c.Env.AddonUpdates == "off" {
		return nil
	}
	reports, chart, pinnedFile, err := imageReports(c)
	if err != nil {
		c.Warnf("note: bundled images weren't checked: %s\n", err)
		return nil
	}
	var changes []imageChange
	for _, report := range reports {
		if report.err != nil {
			c.Warnf("note: couldn't check %s: %s\n", report.path, report.err)
			continue
		}
		if report.pinned || report.chosen == "" {
			continue
		}
		for _, note := range report.notes {
			c.Printf("%s\n", note)
		}
		for _, warning := range report.warnings {
			c.Warnf("%s\n", warning)
		}
		if report.ahead != "" {
			c.Warnf("note: %s is out and needs a person. %s stays on %s. Read its upgrade notes, then set %s in %s.\n",
				report.ahead, report.path, report.chosen, report.path, c.Env.Values)
		}
		if report.chosen == imageAt(chart, report.path) {
			pinnedFile.Unset(report.path)
			continue
		}
		if err := pinnedFile.Put(report.path, report.chosen); err != nil {
			c.Warnf("note: couldn't record %s: %s\n", report.path, err)
			continue
		}
		if report.chosen != report.running {
			c.Printf("%s: %s to %s\n", report.path, report.running, report.chosen)
			changes = append(changes, imageChange{path: report.path, previous: report.running, next: report.chosen})
		}
	}
	if err := pinnedFile.Save(); err != nil {
		c.Warnf("note: couldn't write %s: %s\n", imagesPath(c), err)
		return nil
	}
	return changes
}

func podsNotReady(body []byte, image string) (total, notReady int, err error) {
	var doc struct {
		Items []struct {
			Metadata struct {
				DeletionTimestamp string `json:"deletionTimestamp"`
			} `json:"metadata"`
			Spec struct {
				Containers []struct {
					Name  string `json:"name"`
					Image string `json:"image"`
				} `json:"containers"`
			} `json:"spec"`
			Status struct {
				Phase             string `json:"phase"`
				ContainerStatuses []struct {
					Name  string `json:"name"`
					Ready bool   `json:"ready"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return 0, 0, err
	}
	for _, pod := range doc.Items {
		if pod.Metadata.DeletionTimestamp != "" || pod.Status.Phase == "Succeeded" {
			continue
		}
		for _, container := range pod.Spec.Containers {
			if container.Image != image {
				continue
			}
			total++
			ready := false
			for _, status := range pod.Status.ContainerStatuses {
				if status.Name == container.Name {
					ready = status.Ready
				}
			}
			if !ready {
				notReady++
			}
		}
	}
	return total, notReady, nil
}

func imageComesUp(c *cli.Context, image string) bool {
	started := time.Now()
	deadline := started.Add(imageReadyWait)
	for {
		out, err := c.Capture("kubectl", "get", "pods", "-A", "-o", "json")
		if err == nil {
			total, notReady, parseErr := podsNotReady([]byte(out), image)
			if parseErr == nil && notReady == 0 && (total > 0 || time.Since(started) > imageFirstPodWait) {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Second)
	}
}

func revertFailedImages(c *cli.Context, changes []imageChange, reapply func() error) {
	var failed []imageChange
	for _, change := range changes {
		if !imageComesUp(c, change.next) {
			failed = append(failed, change)
		}
	}
	if len(failed) == 0 {
		return
	}
	pinnedFile, err := loadOrEmptyValues(imagesPath(c))
	if err != nil {
		c.Warnf("note: couldn't read %s to go back: %s\n", imagesPath(c), err)
		return
	}
	for _, change := range failed {
		c.Warnf("note: %s didn't come up. Going back to %s, and it won't be tried again.\n", change.next, change.previous)
		if err := pinnedFile.Put(change.path, change.previous); err != nil {
			c.Warnf("note: couldn't go back on %s: %s\n", change.path, err)
		}
		if err := appendHeld(c, withoutDigest(change.next)); err != nil {
			c.Warnf("note: couldn't record %s: %s\n", change.next, err)
		}
	}
	if err := pinnedFile.Save(); err != nil {
		c.Warnf("note: couldn't write %s: %s\n", imagesPath(c), err)
		return
	}
	if err := reapply(); err != nil {
		c.Warnf("note: going back failed: %s\n", err)
	}
}

func withoutDigest(image string) string {
	ref, _, _ := strings.Cut(image, "@")
	return ref
}

func runningDigests(body []byte) []string {
	var doc struct {
		Items []struct {
			Status struct {
				ContainerStatuses []struct {
					ImageID string `json:"imageID"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil
	}
	var digests []string
	for _, pod := range doc.Items {
		for _, status := range pod.Status.ContainerStatuses {
			if i := strings.LastIndex(status.ImageID, "@"); i >= 0 {
				digests = append(digests, status.ImageID[i+1:])
			}
		}
	}
	return digests
}

func refreshFloatingWorkloads(c *cli.Context) {
	if c.Env.AddonUpdates == "off" {
		return
	}
	client := newRegistryClient()
	held := readHeld(c)
	gate := gateFor(c)
	for _, workload := range floatingWorkloads {
		image, err := c.Capture("kubectl", "-n", workload.namespace, "get", "deploy", workload.name,
			"-o", "jsonpath={.spec.template.spec.containers[0].image}")
		if err != nil {
			continue
		}
		image = strings.TrimSpace(image)
		repo, tag, ok := splitImage(image)
		if !ok {
			continue
		}
		if tag == "latest" {
			restartOnNewLatest(c, client, gate, workload, repo)
		} else {
			movePinnedWorkload(c, client, gate, workload, image, repo, tag, held)
		}
	}
}

func restartOnNewLatest(c *cli.Context, client *registryClient, gate *updateGate, workload floatingWorkload, repo string) {
	digest, err := client.digest(repo, "latest")
	if err != nil {
		c.Warnf("note: couldn't check %s: %s\n", repo, err)
		return
	}
	pods, err := c.Capture("kubectl", "-n", workload.namespace, "get", "pods", "-l", "app="+workload.name, "-o", "json")
	if err != nil {
		return
	}
	running := runningDigests([]byte(pods))
	if len(running) == 0 {
		return
	}
	for _, d := range running {
		if d != digest {
			latest := candidate{tag: imageTag{raw: "latest"}}
			if !gate.soaked(func(candidate) (time.Time, error) { return client.published(repo, "latest") })(latest) {
				c.Printf("%s: a new %s:latest is out and waits until it has been public for %d days\n", workload.name, repo, int(gate.soak.Hours()/24))
				return
			}
			c.Printf("%s: a new %s:latest is out\n", workload.name, repo)
			if err := c.Run("kubectl", "-n", workload.namespace, "rollout", "restart", "deploy/"+workload.name); err != nil {
				c.Warnf("note: couldn't restart %s: %s\n", workload.name, err)
				return
			}
			if err := c.Run("kubectl", "-n", workload.namespace, "rollout", "status", "deploy/"+workload.name, "--timeout=5m"); err != nil {
				c.Warnf("note: %s didn't come back: %s\n", workload.name, err)
			}
			return
		}
	}
}

func movePinnedWorkload(c *cli.Context, client *registryClient, gate *updateGate, workload floatingWorkload, image, repo, rawTag string, held map[string]bool) {
	current, ok := parseImageTag(rawTag)
	if !ok {
		return
	}
	tags, err := client.tags(repo)
	if err != nil {
		c.Warnf("note: couldn't check %s: %s\n", repo, err)
		return
	}
	candidates, ahead := imageCandidates(current, tags, false, workload.anyMajor, workload.securityCrossMinor, held, repo)
	plan := planImage(gate, workload.osv, repo, current, candidates, ahead, client.published)
	notes, warnings := plan.messages(imageCandidate(current), imageName(repo), gate.soak)
	for _, note := range notes {
		c.Printf("%s\n", note)
	}
	for _, warning := range warnings {
		c.Warnf("%s\n", warning)
	}
	best := plan.target.tag
	if ahead != nil {
		c.Warnf("note: %s:%s is out and needs a person. %s stays on %s:%s.\n", repo, ahead.raw, workload.name, repo, best.raw)
	}
	if best.raw == current.raw {
		return
	}
	digest, err := client.digest(repo, best.raw)
	if err != nil {
		c.Warnf("note: couldn't check %s: %s\n", repo, err)
		return
	}
	next := pinnedRef(repo, best.raw, digest)
	deploy := "deploy/" + workload.name
	c.Printf("%s: %s to %s\n", workload.name, image, next)
	if err := c.Run("kubectl", "-n", workload.namespace, "set", "image", deploy, workload.name+"="+next); err != nil {
		c.Warnf("note: couldn't update %s: %s\n", workload.name, err)
		return
	}
	if err := c.Run("kubectl", "-n", workload.namespace, "rollout", "status", deploy, "--timeout=5m"); err == nil {
		return
	}
	c.Warnf("note: %s didn't come up. Going back to %s, and it won't be tried again.\n", next, image)
	if err := c.Run("kubectl", "-n", workload.namespace, "rollout", "undo", deploy); err != nil {
		c.Warnf("note: going back failed: %s\n", err)
	}
	if err := appendHeld(c, repo+":"+best.raw); err != nil {
		c.Warnf("note: couldn't record %s: %s\n", next, err)
	}
}

func latestRailpack() (string, error) {
	client := &http.Client{Timeout: registryTimeout}
	res, err := client.Get("https://api.github.com/repos/railwayapp/railpack/releases/latest")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("api.github.com answered %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	var release struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &release); err != nil {
		return "", err
	}
	return release.TagName, nil
}

func noteRailpack(c *cli.Context, chart *cli.Values) {
	current := imageAt(chart, "builders.railpackVersion")
	if current == "" {
		return
	}
	latest, err := latestRailpack()
	if err != nil || latest == "" || latest == current {
		return
	}
	c.Warnf("note: Railpack %s is out, and this release uses %s. A new Orchard release updates it, because a mismatch breaks builds.\n", latest, current)
}

func Images() *cli.Command {
	return &cli.Command{
		Name:    "images",
		Summary: "show the bundled images and what's available",
		Root:    true,
		Usage: `orchardctl images - show the images Orchard bundles

orchardctl update installs newer versions of these from their own registries,
so a fix doesn't wait on an Orchard release. It writes the versions to
/etc/orchard/images.yaml and passes that file before your values file, so an
image you set in your values file stays as you set it.

  Redis, pgbouncer and BuildKit   patches only
  everything else listed          any version in the same major version

A version below 1.0 treats a minor version as a major one, so 0.61 to 0.62
needs a person and 0.61.0 to 0.61.1 doesn't. A new version waits until it has
been public for 7 days (ORCHARD_UPDATE_SOAK_DAYS in /etc/orchard/env, 0 turns
the wait off). The date comes from Docker Hub or quay.io for their images, and
from the image's creation date elsewhere. A version without a date waits.

If OSV.dev lists a vulnerability in the running version, the update moves at
once to the release that fixes it without adding another known vulnerability,
and prints "security update". For the tools that keep no data (Trivy, Vector,
skopeo, vmagent, kube-state-metrics, node-exporter, aws-cli and cloudflared),
that release can be a new minor version below 1.0 when no release in the
running minor fixes it. If OSV.dev can't be reached, only the wait applies.

Each version it picks is pinned to the digest the registry served for it. The
installer's zot and cloudflared move the same way, cloudflared to any newer
release. A new major version always needs a person. If a new version doesn't
come up, the update goes back and doesn't try that version again. To turn this off, set
ORCHARD_ADDON_UPDATES=off in /etc/orchard/env.
`,
		Run: func(c *cli.Context, args []string) error {
			reports, chart, _, err := imageReports(c)
			if err != nil {
				return err
			}
			for _, report := range reports {
				switch {
				case report.err != nil:
					c.Printf("%-34s %s (couldn't check: %s)\n", report.path, report.running, report.err)
				case report.running == "":
					continue
				case report.pinned:
					c.Printf("%-34s %s (set in your values file)\n", report.path, report.running)
				case report.ahead != "" && report.chosen != report.running:
					c.Printf("%-34s %s, can move to %s, %s needs a person\n", report.path, report.running, report.chosen, report.ahead)
				case report.ahead != "":
					c.Printf("%-34s %s, %s needs a person\n", report.path, report.running, report.ahead)
				case report.chosen != report.running:
					c.Printf("%-34s %s, can move to %s\n", report.path, report.running, report.chosen)
				default:
					c.Printf("%-34s %s\n", report.path, report.running)
				}
				for _, note := range append(report.notes, report.warnings...) {
					c.Printf("%-34s %s\n", "", note)
				}
			}
			noteRailpack(c, chart)
			return nil
		},
	}
}
