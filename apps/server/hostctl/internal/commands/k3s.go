package commands

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	k3sBinary      = "/usr/local/bin/k3s"
	k3sDatabaseDir = "/var/lib/rancher/k3s/server/db"

	k3sNodeTimeout   = 5 * time.Minute
	k3sServerTimeout = "10m"
)

var (
	k3sChannelsURL = "https://update.k3s.io/v1-release/channels"
	k3sReleaseURL  = "https://github.com/k3s-io/k3s/releases/download"
)

var k3sVersionPattern = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)\+k3s(\d+)$`)

type k3sVersion struct {
	major, minor, patch, build int
	raw                        string
}

func parseK3sVersion(raw string) (k3sVersion, error) {
	m := k3sVersionPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return k3sVersion{}, fmt.Errorf("%q isn't a k3s version", raw)
	}
	n := func(i int) int {
		v, _ := strconv.Atoi(m[i])
		return v
	}
	return k3sVersion{major: n(1), minor: n(2), patch: n(3), build: n(4), raw: m[0]}, nil
}

func (v k3sVersion) channel() string {
	return fmt.Sprintf("v%d.%d", v.major, v.minor)
}

func (v k3sVersion) newerThan(o k3sVersion) bool {
	for _, pair := range [][2]int{{v.major, o.major}, {v.minor, o.minor}, {v.patch, o.patch}, {v.build, o.build}} {
		if pair[0] != pair[1] {
			return pair[0] > pair[1]
		}
	}
	return false
}

type k3sChannels map[string]k3sVersion

func parseK3sChannels(body []byte) (k3sChannels, error) {
	var doc struct {
		Data []struct {
			Name   string `json:"name"`
			Latest string `json:"latest"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("k3s channels: %w", err)
	}
	channels := k3sChannels{}
	for _, c := range doc.Data {
		if v, err := parseK3sVersion(c.Latest); err == nil {
			channels[c.Name] = v
		}
	}
	if _, ok := channels["stable"]; !ok {
		return nil, errors.New("k3s channels: no stable channel")
	}
	return channels, nil
}

func fetchK3sChannels() (k3sChannels, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Get(k3sChannelsURL)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", k3sChannelsURL, res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	return parseK3sChannels(body)
}

func k3sPatchTarget(current k3sVersion, channels k3sChannels) (k3sVersion, bool) {
	latest, ok := channels[current.channel()]
	if !ok || !latest.newerThan(current) {
		return k3sVersion{}, false
	}
	return latest, true
}

func k3sUpgradePath(current k3sVersion, channels k3sChannels) ([]k3sVersion, error) {
	var path []k3sVersion
	if target, ok := k3sPatchTarget(current, channels); ok {
		path = append(path, target)
	}
	stable := channels["stable"]
	for minor := current.minor + 1; minor <= stable.minor; minor++ {
		name := fmt.Sprintf("v%d.%d", current.major, minor)
		target, ok := channels[name]
		if !ok {
			return nil, fmt.Errorf("k3s publishes no %s channel, and minor versions can't be skipped", name)
		}
		path = append(path, target)
	}
	return path, nil
}

func k3sOutOfSupport(current k3sVersion, channels k3sChannels) bool {
	newest, ok := channels["latest"]
	if !ok {
		newest = channels["stable"]
	}
	return current.minor < newest.minor-2
}

func k3sAssets(arch string) (binary, checksums string, err error) {
	switch arch {
	case "amd64":
		return "k3s", "sha256sum-amd64.txt", nil
	case "arm64":
		return "k3s-arm64", "sha256sum-arm64.txt", nil
	case "arm":
		return "k3s-armhf", "sha256sum-arm.txt", nil
	}
	return "", "", fmt.Errorf("k3s has no build for %s", arch)
}

func k3sChecksum(sums, asset string) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(sums))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("no checksum for %s", asset)
}

func downloadK3s(version k3sVersion, dest string) error {
	binary, checksums, err := k3sAssets(runtime.GOARCH)
	if err != nil {
		return err
	}
	base := k3sReleaseURL + "/" + url.PathEscape(version.raw)
	client := &http.Client{Timeout: 15 * time.Minute}

	get := func(u string) (*http.Response, error) {
		res, err := client.Get(u)
		if err != nil {
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return nil, fmt.Errorf("%s answered %d", u, res.StatusCode)
		}
		return res, nil
	}

	res, err := get(base + "/" + checksums)
	if err != nil {
		return err
	}
	sums, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	res.Body.Close()
	if err != nil {
		return err
	}
	want, err := k3sChecksum(string(sums), binary)
	if err != nil {
		return err
	}

	res, err = get(base + "/" + binary)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, hash), res.Body); err != nil {
		out.Close()
		os.Remove(dest)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dest)
		return err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		os.Remove(dest)
		return fmt.Errorf("the k3s download doesn't match its checksum: got %s, want %s", got, want)
	}
	return nil
}

func installedK3s(c *cli.Context) (k3sVersion, error) {
	out, err := c.Capture(k3sBinary, "--version")
	if err != nil {
		return k3sVersion{}, err
	}
	fields := strings.Fields(out)
	if len(fields) < 3 {
		return k3sVersion{}, errors.New("k3s --version printed nothing useful")
	}
	return parseK3sVersion(fields[2])
}

type k3sNode struct {
	name         string
	version      string
	ready        bool
	controlPlane bool
}

func parseK3sNodes(body []byte) ([]k3sNode, error) {
	var doc struct {
		Items []struct {
			Metadata struct {
				Name   string            `json:"name"`
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			Status struct {
				NodeInfo struct {
					KubeletVersion string `json:"kubeletVersion"`
				} `json:"nodeInfo"`
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	nodes := make([]k3sNode, 0, len(doc.Items))
	for _, item := range doc.Items {
		node := k3sNode{name: item.Metadata.Name, version: item.Status.NodeInfo.KubeletVersion}
		_, node.controlPlane = item.Metadata.Labels["node-role.kubernetes.io/control-plane"]
		for _, condition := range item.Status.Conditions {
			if condition.Type == "Ready" {
				node.ready = condition.Status == "True"
			}
		}
		nodes = append(nodes, node)
	}
	return nodes, nil
}

func k3sNodes(c *cli.Context) ([]k3sNode, error) {
	out, err := c.Capture("kubectl", "get", "nodes", "-o", "json")
	if err != nil {
		return nil, err
	}
	return parseK3sNodes([]byte(out))
}

func k3sControlPlanes(nodes []k3sNode) []k3sNode {
	var planes []k3sNode
	for _, node := range nodes {
		if node.controlPlane {
			planes = append(planes, node)
		}
	}
	return planes
}

func k3sWorkersBehind(nodes []k3sNode, version string) []string {
	var behind []string
	for _, node := range nodes {
		if !node.controlPlane && node.version != version {
			behind = append(behind, node.name+" ("+node.version+")")
		}
	}
	return behind
}

func waitForK3s(c *cli.Context, target string) error {
	deadline := time.Now().Add(k3sNodeTimeout)
	for {
		if nodes, err := k3sNodes(c); err == nil {
			planes := k3sControlPlanes(nodes)
			if len(planes) == 1 && planes[0].ready && planes[0].version == target {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the node didn't report Ready on %s within %s", target, k3sNodeTimeout)
		}
		time.Sleep(3 * time.Second)
	}
}

func waitForServer(c *cli.Context) error {
	if _, err := c.KubectlOut("get", "deploy/server"); err != nil {
		return nil
	}
	if _, err := c.KubectlOut("rollout", "status", "deploy/server", "--timeout="+k3sServerTimeout); err != nil {
		return errors.New("the Orchard server didn't come back")
	}
	return nil
}

func copyK3sDatabase(from, to string) error {
	entries, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(to); err != nil {
		return err
	}
	if err := os.MkdirAll(to, 0o700); err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		if err := copyFile(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func restoreK3sDatabase(backup, live string) error {
	entries, err := os.ReadDir(live)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() {
			if err := os.Remove(filepath.Join(live, entry.Name())); err != nil {
				return err
			}
		}
	}
	saved, err := os.ReadDir(backup)
	if err != nil {
		return err
	}
	for _, entry := range saved {
		if err := copyFile(filepath.Join(backup, entry.Name()), filepath.Join(live, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func installK3sVersion(c *cli.Context, current, target k3sVersion) error {
	next := k3sBinary + ".new"
	previous := k3sBinary + ".previous"
	backup := k3sDatabaseDir + ".previous"

	c.Printf("k3s: downloading %s\n", target.raw)
	if err := downloadK3s(target, next); err != nil {
		return err
	}
	defer os.Remove(next)

	c.Printf("k3s: restarting on %s. Apps keep running, the API pauses.\n", target.raw)
	if err := c.Run("systemctl", "stop", k3sUnit); err != nil {
		return err
	}

	_, statErr := os.Stat(filepath.Join(k3sDatabaseDir, "state.db"))
	saved := statErr == nil
	if saved {
		if err := copyK3sDatabase(k3sDatabaseDir, backup); err != nil {
			c.Run("systemctl", "start", "--no-block", k3sUnit)
			return fmt.Errorf("couldn't copy the k3s database: %w", err)
		}
	}

	if err := copyFile(k3sBinary, previous); err != nil {
		c.Run("systemctl", "start", "--no-block", k3sUnit)
		return err
	}
	if err := os.Rename(next, k3sBinary); err != nil {
		c.Run("systemctl", "start", "--no-block", k3sUnit)
		return err
	}
	if _, err := exec.LookPath("restorecon"); err == nil {
		c.Capture("restorecon", k3sBinary)
	}
	if err := c.Run("systemctl", "start", "--no-block", k3sUnit); err != nil {
		return err
	}

	healthy := waitForK3s(c, target.raw)
	if healthy == nil {
		healthy = waitForServer(c)
	}
	if healthy == nil {
		c.Printf("k3s: now on %s\n", target.raw)
		return nil
	}

	c.Warnf("k3s: %s, going back to %s\n", healthy, current.raw)
	if err := c.Run("systemctl", "stop", k3sUnit); err != nil {
		return fmt.Errorf("%w, and k3s wouldn't stop to roll back: %s", healthy, err)
	}
	if saved {
		if err := restoreK3sDatabase(backup, k3sDatabaseDir); err != nil {
			return fmt.Errorf("%w, and the k3s database couldn't be restored from %s: %s", healthy, backup, err)
		}
	}
	if err := os.Rename(previous, k3sBinary); err != nil {
		return fmt.Errorf("%w, and %s couldn't be restored: %s", healthy, previous, err)
	}
	if err := c.Run("systemctl", "start", "--no-block", k3sUnit); err != nil {
		return fmt.Errorf("%w, and k3s wouldn't start again: %s", healthy, err)
	}
	if err := waitForK3s(c, current.raw); err != nil {
		return fmt.Errorf("%w, and after rolling back: %s", healthy, err)
	}
	return fmt.Errorf("%w. Back on %s", healthy, current.raw)
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func k3sManaged() bool {
	if _, err := os.Stat(k3sBinary); err != nil {
		return false
	}
	_, err := exec.LookPath("systemctl")
	return err == nil
}

func k3sPreflight(c *cli.Context) ([]k3sNode, error) {
	nodes, err := k3sNodes(c)
	if err != nil {
		return nil, fmt.Errorf("couldn't read the nodes: %w", err)
	}
	planes := k3sControlPlanes(nodes)
	if len(planes) != 1 {
		return nil, fmt.Errorf("this cluster has %d control-plane nodes, so upgrade k3s by hand, one at a time", len(planes))
	}
	if !planes[0].ready {
		return nil, fmt.Errorf("%s isn't Ready, so k3s stays as it is", planes[0].name)
	}
	return nodes, nil
}

func noteK3sNodes(c *cli.Context, version string) {
	nodes, err := k3sNodes(c)
	if err != nil {
		return
	}
	if behind := k3sWorkersBehind(nodes, version); len(behind) > 0 {
		c.Warnf("note: these worker nodes aren't on %s yet: %s\n", version, strings.Join(behind, ", "))
		c.Warnf("Upgrade each one by running the k3s install script on it with INSTALL_K3S_VERSION=%q.\n", version)
	}
}

func noteK3sSupport(c *cli.Context, current k3sVersion, channels k3sChannels) {
	if k3sOutOfSupport(current, channels) {
		c.Warnf("note: Kubernetes %s no longer gets security fixes. To move to %s, run: sudo orchardctl k3s upgrade\n",
			strings.TrimPrefix(current.channel(), "v"), channels["stable"].raw)
	}
}

func patchK3s(c *cli.Context) error {
	if c.Env.K3sUpdates == "off" || !k3sManaged() {
		return nil
	}
	current, err := installedK3s(c)
	if err != nil {
		return err
	}
	channels, err := fetchK3sChannels()
	if err != nil {
		return err
	}
	if target, ok := k3sPatchTarget(current, channels); ok {
		if _, err := k3sPreflight(c); err != nil {
			return err
		}
		if err := installK3sVersion(c, current, target); err != nil {
			return err
		}
		noteK3sNodes(c, target.raw)
		current = target
	}
	noteK3sSupport(c, current, channels)
	return nil
}

func k3sStatus(c *cli.Context) error {
	if !k3sManaged() {
		return errors.New("no k3s service on this server")
	}
	current, err := installedK3s(c)
	if err != nil {
		return err
	}
	c.Printf("k3s %s\n", current.raw)
	if c.Env.K3sUpdates == "off" {
		c.Printf("automatic patches are off, because ORCHARD_K3S_UPDATES=off in %s/env\n", c.Env.StateDir)
	}
	channels, err := fetchK3sChannels()
	if err != nil {
		return fmt.Errorf("couldn't read the k3s channels: %w", err)
	}
	if target, ok := k3sPatchTarget(current, channels); ok {
		c.Printf("patch available: %s, applied by orchardctl update\n", target.raw)
	} else {
		c.Printf("on the latest patch of %s\n", current.channel())
	}
	if stable := channels["stable"]; stable.minor > current.minor {
		c.Printf("newer minor version: %s, applied by orchardctl k3s upgrade\n", stable.raw)
	}
	noteK3sSupport(c, current, channels)
	return nil
}

func k3sUpgrade(c *cli.Context) error {
	if !k3sManaged() {
		return errors.New("no k3s service on this server")
	}
	current, err := installedK3s(c)
	if err != nil {
		return err
	}
	channels, err := fetchK3sChannels()
	if err != nil {
		return fmt.Errorf("couldn't read the k3s channels: %w", err)
	}
	path, err := k3sUpgradePath(current, channels)
	if err != nil {
		return err
	}
	if len(path) == 0 {
		c.Printf("k3s %s is already on the stable channel's version or newer\n", current.raw)
		return nil
	}
	for _, target := range path {
		if _, err := k3sPreflight(c); err != nil {
			return err
		}
		if err := installK3sVersion(c, current, target); err != nil {
			return err
		}
		current = target
	}
	noteK3sNodes(c, current.raw)
	return nil
}

func K3s() *cli.Command {
	return &cli.Command{
		Name:    "k3s",
		Summary: "show the k3s version, or move to a newer minor version",
		Args:    "[status|patch|upgrade]",
		Root:    true,
		Usage: `orchardctl k3s - keep k3s and Kubernetes up to date

  status    show this server's version and what's available (default)
  patch     apply the latest patch of the current minor version
  upgrade   move to the version on k3s's stable channel, one minor at a time

Versions come from k3s's own release channels. orchardctl update applies patches
on its own. To turn that off, set ORCHARD_K3S_UPDATES=off in /etc/orchard/env.

Each step checks the download against its published checksum, stops k3s, copies
its database, and swaps the binary. Apps keep running while the API pauses. If the
node or the Orchard server doesn't come back, the step puts the old version and
database back, and the command stops.

Moving to a newer minor version can change how a workload behaves, so only
upgrade does it. Back up first. Worker nodes are not upgraded: the command lists
any that are behind. A cluster with more than one control-plane node is left for
you to upgrade by hand.
`,
		Run: func(c *cli.Context, args []string) error {
			action := "status"
			if len(args) > 0 {
				action = args[0]
			}
			switch action {
			case "status":
				return k3sStatus(c)
			case "patch":
				saved := c.Env.K3sUpdates
				c.Env.K3sUpdates = "on"
				defer func() { c.Env.K3sUpdates = saved }()
				if !k3sManaged() {
					return errors.New("no k3s service on this server")
				}
				return patchK3s(c)
			case "upgrade":
				return k3sUpgrade(c)
			}
			return fmt.Errorf("unknown action %q: use status, patch or upgrade", action)
		},
	}
}
