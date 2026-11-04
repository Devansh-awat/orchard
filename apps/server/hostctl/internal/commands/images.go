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
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

type bundledImage struct {
	path      string
	patchOnly bool
}

var bundledImages = []bundledImage{
	{path: "redis.image", patchOnly: true},
	{path: "postgres.pooler.image", patchOnly: true},
	{path: "builders.buildkitImage", patchOnly: true},
	{path: "metrics.victoriametrics.image"},
	{path: "metrics.vmagent.image"},
	{path: "metrics.kubeStateMetrics.image"},
	{path: "metrics.nodeExporter.image"},
	{path: "logs.victorialogs.image"},
	{path: "logs.vector.image"},
	{path: "trivy.image"},
	{path: "objectStorage.local.image"},
	{path: "objectStorage.local.bucketImage"},
	{path: "databaseDumps.uploaderImage"},
}

type floatingWorkload struct {
	namespace string
	name      string
}

var floatingWorkloads = []floatingWorkload{
	{namespace: "orchard", name: "zot"},
	{namespace: "cloudflared", name: "cloudflared"},
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
	i := strings.LastIndex(image, ":")
	if i < 0 || strings.Contains(image[i:], "/") || strings.Contains(image, "@") {
		return "", "", false
	}
	return image[:i], image[i+1:], true
}

func chooseImageTag(current imageTag, tags []string, patchOnly bool, held map[string]bool, repo string) (best, ahead imageTag) {
	best = current
	ahead = current
	for _, raw := range tags {
		tag, ok := parseImageTag(raw)
		if !ok || tag.prefix != current.prefix || tag.suffix != current.suffix {
			continue
		}
		if tag.newerThan(ahead) {
			ahead = tag
		}
		if held[repo+":"+raw] || tag.major != current.major {
			continue
		}
		if patchOnly && tag.minor != current.minor {
			continue
		}
		if tag.newerThan(best) {
			best = tag
		}
	}
	return best, ahead
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
	http *http.Client
}

func newRegistryClient() *registryClient {
	return &registryClient{http: &http.Client{Timeout: registryTimeout}}
}

func (r *registryClient) token(challenge string) (string, error) {
	tokenURL, err := tokenURLFromChallenge(challenge)
	if err != nil {
		return "", err
	}
	res, err := r.http.Get(tokenURL)
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
	path    string
	running string
	chosen  string
	ahead   string
	pinned  bool
	err     error
}

func imageAt(values *cli.Values, path string) string {
	if values == nil {
		return ""
	}
	s, _ := values.Get(path).(string)
	return s
}

func reportImage(entry bundledImage, chart, user, pinnedFile *cli.Values, tagsFor func(string) ([]string, error), held map[string]bool) imageReport {
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
	tags, err := tagsFor(repo)
	if err != nil {
		report.err = err
		return report
	}
	best, ahead := chooseImageTag(current, tags, entry.patchOnly, held, repo)
	report.chosen = repo + ":" + best.raw
	if ahead.raw != best.raw {
		report.ahead = repo + ":" + ahead.raw
	}
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
	held := readHeld(c)
	reports := make([]imageReport, 0, len(bundledImages))
	for _, entry := range bundledImages {
		reports = append(reports, reportImage(entry, chart, user, pinnedFile, tagsFor, held))
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
		if report.ahead != "" {
			c.Warnf("note: %s is out and needs a person. %s stays on %s. Read its upgrade notes, then set %s in %s.\n",
				report.ahead, report.path, report.chosen, report.path, c.Env.Values)
		}
		if report.chosen == imageAt(chart, report.path) {
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
		if err := appendHeld(c, change.next); err != nil {
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
	for _, workload := range floatingWorkloads {
		image, err := c.Capture("kubectl", "-n", workload.namespace, "get", "deploy", workload.name,
			"-o", "jsonpath={.spec.template.spec.containers[0].image}")
		if err != nil {
			continue
		}
		repo, tag, ok := splitImage(strings.TrimSpace(image))
		if !ok || tag != "latest" {
			continue
		}
		digest, err := client.digest(repo, tag)
		if err != nil {
			c.Warnf("note: couldn't check %s: %s\n", repo, err)
			continue
		}
		pods, err := c.Capture("kubectl", "-n", workload.namespace, "get", "pods", "-l", "app="+workload.name, "-o", "json")
		if err != nil {
			continue
		}
		running := runningDigests([]byte(pods))
		if len(running) == 0 {
			continue
		}
		current := true
		for _, d := range running {
			if d != digest {
				current = false
			}
		}
		if current {
			continue
		}
		c.Printf("%s: a new %s:latest is out\n", workload.name, repo)
		if err := c.Run("kubectl", "-n", workload.namespace, "rollout", "restart", "deploy/"+workload.name); err != nil {
			c.Warnf("note: couldn't restart %s: %s\n", workload.name, err)
			continue
		}
		if err := c.Run("kubectl", "-n", workload.namespace, "rollout", "status", "deploy/"+workload.name, "--timeout=5m"); err != nil {
			c.Warnf("note: %s didn't come back: %s\n", workload.name, err)
		}
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

A new major version always needs a person. If a new version doesn't come up, the
update goes back and doesn't try that version again. To turn this off, set
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
			}
			noteRailpack(c, chart)
			return nil
		},
	}
}
