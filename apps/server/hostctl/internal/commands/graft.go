package commands

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	graftsPath             = "grafts"
	graftSettingsPath      = "graftSettings"
	defaultGraftMarketURL  = "https://assets.orchard.my/registry"
	graftSnapshotsKept     = 5
	graftAdminScript       = "dist/scripts/graft-admin.js"
	graftTrustWarning      = "Grafts run with the same access as Orchard, including your database and your users' data. Only install grafts you trust."
	graftUnsignedWarning   = "This graft is NOT signed by Orchard or a publisher key you added."
	graftHistoryFile       = "graft-history.json"
	graftSnapshotDirectory = "graft-snapshots"
)

type graftSpec struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Source  string `json:"source,omitempty"`
	Digest  string `json:"digest,omitempty"`
	Tap     string `json:"tap,omitempty"`
}

type graftManifest struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Version      string              `json:"version"`
	Publisher    string              `json:"publisher"`
	Description  string              `json:"description"`
	Engines      map[string]string   `json:"engines"`
	Capabilities []string            `json:"capabilities"`
	Claims       map[string][]string `json:"claims"`
	Database     struct {
		CoreReads map[string][]string `json:"coreReads"`
		Adopts    []string            `json:"adopts"`
	} `json:"database"`
	Public   struct{ Routes []string } `json:"public"`
	Requires struct {
		Grafts     map[string]string `json:"grafts"`
		Kubernetes struct {
			Crds []string `json:"crds"`
		} `json:"kubernetes"`
	} `json:"requires"`
}

type graftCheck struct {
	Manifest      graftManifest   `json:"manifest"`
	Digest        string          `json:"digest"`
	Signature     *graftSignature `json:"signature"`
	Problems      []string        `json:"problems"`
	ShadowedClaim []struct {
		Kind       string `json:"kind"`
		Value      string `json:"value"`
		ShadowedBy string `json:"shadowedBy"`
	} `json:"shadowedClaims"`
	Migrations struct {
		Pending []string `json:"pending"`
		DryRun  string   `json:"dryRun"`
	} `json:"migrations"`
}

type graftSignature struct {
	Tier      *string `json:"tier"`
	SignedBy  *string `json:"signedBy"`
	KeyID     *string `json:"keyId"`
	Publisher string  `json:"publisher"`
	Repo      string  `json:"repo"`
	Tap       string  `json:"tap"`
}

type graftInfo struct {
	Platform  string `json:"platform"`
	SDK       string `json:"sdk"`
	Installed []struct {
		ID         string            `json:"id"`
		Version    string            `json:"version"`
		Requires   map[string]string `json:"requires"`
		Migrations []string          `json:"migrations"`
	} `json:"installed"`
}

type marketVersion struct {
	Version     string            `json:"version"`
	Digest      string            `json:"digest"`
	URL         string            `json:"url"`
	Size        int64             `json:"size"`
	Signed      bool              `json:"signed"`
	Engines     map[string]string `json:"engines"`
	PublishedAt string            `json:"publishedAt"`
	Revoked     bool              `json:"revoked"`
}

type marketGraft struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Publisher      string          `json:"publisher"`
	Homepage       string          `json:"homepage"`
	Tier           string          `json:"tier"`
	Repo           string          `json:"repo"`
	PublisherKeyID string          `json:"publisherKeyId"`
	Latest         string          `json:"latest"`
	Versions       []marketVersion `json:"versions"`
}

type marketIndex struct {
	Grafts  []marketGraft `json:"grafts"`
	Revoked []string      `json:"revoked"`
}

type graftHistoryEntry struct {
	Spec     graftSpec `json:"spec"`
	Replaced string    `json:"replacedAt"`
	Snapshot string    `json:"snapshot,omitempty"`
}

func Graft() *cli.Command {
	return &cli.Command{
		Name:    "graft",
		Args:    "<command>",
		Summary: "install and manage grafts (Orchard's extensions)",
		Root:    true,
		Usage: `orchardctl graft - install and manage grafts, Orchard's extensions

  orchardctl graft search [term]             browse the Extension Marketplace and your taps
  orchardctl graft info <id>                 tier, publisher, versions and compatibility
  orchardctl graft list                      what is installed and how it is doing
  orchardctl graft add <id>[@version]        install from the Extension Marketplace
  orchardctl graft add <tap>/<id>[@version]  install from a tap you added
  orchardctl graft add ./x.graft             install a file (works offline)
  orchardctl graft add https://.../x.graft   install from any https address, pinned by digest
  orchardctl graft upgrade [id]              move to the newest compatible version
  orchardctl graft remove <id> [--purge]     uninstall; --purge also deletes its data
  orchardctl graft rollback <id>             go back to the previous version and data
  orchardctl graft pool <id> [n|default]     database connections the graft may open per pod
  orchardctl graft tap add <name> <url>      trust a third-party tap and its signing key
  orchardctl graft tap list                  the taps you added and their keys
  orchardctl graft tap remove <name>         stop trusting a tap
  orchardctl graft trust [level]             show or set which grafts may load:
                                             official, listed (default), taps or any

Flags for add and upgrade:
  --yes        skip the confirmation prompt
  --dry-run    verify the graft and list its database changes, change nothing
  --apply      roll Orchard out afterwards (otherwise run orchardctl update)

` + graftTrustWarning + `

Official grafts are made and signed by Orchard. Community grafts are listed in
the Extension Marketplace and signed by their publisher; Orchard checked them
when they were listed but doesn't review their updates. Taps are folders of
grafts run by someone else; Orchard checks nothing in them.

Every install and upgrade verifies the signature against your trust policy
(graftSettings.trust), checks the graft against this Orchard version, and
rehearses its database migrations inside a transaction that is rolled back.
Before any migration runs, the graft's own schema is saved under
/etc/orchard/graft-snapshots so rollback can restore it. Orchard's own data is
never touched.
`,
		Run: runGraft,
	}
}

func runGraft(c *cli.Context, args []string) error {
	if len(args) == 0 {
		c.Printf("%s", Graft().Usage)
		return nil
	}
	rest, apply := splitApply(args[1:])
	flags, positional := splitGraftFlags(rest)
	switch args[0] {
	case "search":
		return graftSearch(c, strings.Join(positional, " "))
	case "info":
		if len(positional) != 1 {
			return errors.New("usage: orchardctl graft info <id> | <tap>/<id>")
		}
		return graftDescribe(c, positional[0])
	case "list":
		return graftList(c)
	case "add":
		if len(positional) != 1 {
			return errors.New("usage: orchardctl graft add <id>[@version] | <tap>/<id>[@version] | <file.graft> | <https url>")
		}
		return graftAdd(c, positional[0], flags, apply)
	case "upgrade":
		return graftUpgrade(c, positional, flags, apply)
	case "remove":
		if len(positional) != 1 {
			return errors.New("usage: orchardctl graft remove <id> [--purge] [--apply]")
		}
		return graftRemove(c, positional[0], flags["purge"], apply)
	case "pool":
		if len(positional) < 1 || len(positional) > 2 {
			return errors.New("usage: orchardctl graft pool <id> [n|default] [--apply]")
		}
		return graftPool(c, positional, apply)
	case "rollback":
		if len(positional) != 1 {
			return errors.New("usage: orchardctl graft rollback <id> [--apply]")
		}
		return graftRollback(c, positional[0], flags, apply)
	case "tap":
		return runGraftTap(c, positional, flags)
	case "trust":
		return graftTrustCommand(c, positional, apply)
	default:
		return fmt.Errorf("unknown graft command %q; run orchardctl graft for help", args[0])
	}
}

func splitGraftFlags(args []string) (map[string]bool, []string) {
	flags := map[string]bool{}
	var positional []string
	for _, a := range args {
		if strings.HasPrefix(a, "--") {
			flags[strings.TrimPrefix(a, "--")] = true
			continue
		}
		positional = append(positional, a)
	}
	return flags, positional
}

func graftMarketURL(values *cli.Values) string {
	if values != nil {
		if s, ok := values.Get(graftSettingsPath + ".marketplaceUrl").(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimRight(strings.TrimSpace(s), "/")
		}
	}
	return defaultGraftMarketURL
}

func graftTrustEnv(values *cli.Values) []string {
	trust := "signed"
	var keys []string
	taps := "[]"
	if values != nil {
		if s, ok := values.Get(graftTrustPath).(string); ok && s != "" {
			trust = s
		}
		taps = graftTapsEnv(values)
		for _, k := range values.List(graftSettingsPath + ".keys") {
			if s, ok := k.(string); ok {
				keys = append(keys, s)
			}
		}
	}
	return []string{
		"ORCHARD_GRAFT_TRUST=" + trust,
		"ORCHARD_GRAFT_KEYS=" + strings.Join(keys, ","),
		"ORCHARD_GRAFT_MARKETPLACE_URL=" + graftMarketURL(values),
		"ORCHARD_GRAFT_TAPS=" + taps,
	}
}

func fetchJSON(url string, into any) error {
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", url, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(into)
}

func loadMarket(values *cli.Values) (marketIndex, error) {
	var index marketIndex
	err := fetchJSON(graftMarketURL(values)+"/grafts/index.json", &index)
	return index, err
}

func (m marketIndex) find(id string) (marketGraft, bool) {
	for _, g := range m.Grafts {
		if g.ID == id {
			return g, true
		}
	}
	return marketGraft{}, false
}

func (m marketIndex) revoked(digest string) bool {
	for _, d := range m.Revoked {
		if strings.EqualFold(d, digest) {
			return true
		}
	}
	return false
}

func serverExec(c *cli.Context, stdin io.Reader, extraEnv []string, args ...string) ([]byte, error) {
	kubectlArgs := []string{"-n", c.Env.Namespace, "exec", "-i", "deploy/server", "-c", "server", "--", "env"}
	kubectlArgs = append(kubectlArgs, extraEnv...)
	kubectlArgs = append(kubectlArgs, "node", graftAdminScript)
	kubectlArgs = append(kubectlArgs, args...)
	cmd := exec.Command("kubectl", kubectlArgs...)
	cmd.Env = append(os.Environ(), "KUBECONFIG="+c.Env.Kubeconfig)
	cmd.Stdin = stdin
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("server: %s", msg)
	}
	return out, nil
}

func instanceInfo(c *cli.Context) (graftInfo, error) {
	var info graftInfo
	out, err := serverExec(c, nil, nil, "info")
	if err != nil {
		return info, err
	}
	return info, json.Unmarshal(out, &info)
}

func readGraftSpecs(values *cli.Values) []graftSpec {
	var specs []graftSpec
	for _, item := range values.List(graftsPath) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		spec := graftSpec{}
		spec.ID, _ = m["id"].(string)
		spec.Version = fmt.Sprint(m["version"])
		spec.Source, _ = m["source"].(string)
		spec.Digest, _ = m["digest"].(string)
		spec.Tap, _ = m["tap"].(string)
		if spec.ID != "" {
			specs = append(specs, spec)
		}
	}
	return specs
}

func writeGraftSpecs(values *cli.Values, specs []graftSpec) {
	items := make([]any, 0, len(specs))
	for _, s := range specs {
		entry := map[string]any{"id": s.ID, "version": s.Version}
		if s.Digest != "" {
			entry["digest"] = s.Digest
		}
		if s.Source != "" {
			entry["source"] = s.Source
		}
		if s.Tap != "" {
			entry["tap"] = s.Tap
		}
		items = append(items, entry)
	}
	values.SetList(graftsPath, items)
}

func upsertSpec(specs []graftSpec, next graftSpec) ([]graftSpec, *graftSpec) {
	for i, s := range specs {
		if s.ID == next.ID {
			prev := s
			specs[i] = next
			return specs, &prev
		}
	}
	return append(specs, next), nil
}

func versionParts(v string) [3]int {
	var out [3]int
	core := strings.SplitN(strings.TrimPrefix(v, "v"), "-", 2)[0]
	for i, p := range strings.SplitN(core, ".", 3) {
		n, _ := strconv.Atoi(p)
		if i < 3 {
			out[i] = n
		}
	}
	return out
}

func versionLess(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func satisfiesRange(version, rng string) bool {
	rng = strings.TrimSpace(rng)
	if rng == "" || rng == "*" {
		return true
	}
	for _, alt := range strings.Split(rng, "||") {
		ok := true
		for _, tok := range strings.Fields(alt) {
			if !satisfiesToken(version, tok) {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func satisfiesToken(version, tok string) bool {
	v := versionParts(version)
	cmp := func(base string) int {
		b := versionParts(base)
		for i := 0; i < 3; i++ {
			if v[i] != b[i] {
				if v[i] < b[i] {
					return -1
				}
				return 1
			}
		}
		return 0
	}
	switch {
	case strings.HasPrefix(tok, ">="):
		return cmp(tok[2:]) >= 0
	case strings.HasPrefix(tok, "<="):
		return cmp(tok[2:]) <= 0
	case strings.HasPrefix(tok, ">"):
		return cmp(tok[1:]) > 0
	case strings.HasPrefix(tok, "<"):
		return cmp(tok[1:]) < 0
	case strings.HasPrefix(tok, "^"):
		b := versionParts(tok[1:])
		if cmp(tok[1:]) < 0 {
			return false
		}
		if b[0] > 0 {
			return v[0] == b[0]
		}
		if b[1] > 0 {
			return v[0] == 0 && v[1] == b[1]
		}
		return v == b
	case strings.HasPrefix(tok, "~"):
		b := versionParts(tok[1:])
		return cmp(tok[1:]) >= 0 && v[0] == b[0] && v[1] == b[1]
	default:
		return cmp(strings.TrimPrefix(tok, "=")) == 0
	}
}

func newestCompatible(g marketGraft, platform string, index marketIndex) (marketVersion, bool) {
	var best marketVersion
	found := false
	for _, v := range g.Versions {
		if v.Revoked || index.revoked(v.Digest) || !satisfiesRange(platform, v.Engines["platform"]) {
			continue
		}
		if !found || versionLess(best.Version, v.Version) {
			best, found = v, true
		}
	}
	return best, found
}

func graftSearch(c *cli.Context, term string) error {
	values, _ := cli.LoadValues(c.Env.Values)
	term = strings.ToLower(term)
	matched := 0
	show := func(g marketGraft, tap string) {
		hay := strings.ToLower(g.ID + " " + g.Name + " " + g.Description + " " + g.Publisher + " " + tap)
		if term != "" && !strings.Contains(hay, term) {
			return
		}
		matched++
		id := g.ID
		if tap != "" {
			id = tap + "/" + g.ID
		}
		c.Printf("%-28s %-10s %-24s %s\n", id, g.Latest, tierLabel(g, tap), g.Description)
	}
	index, err := loadMarket(values)
	if err != nil {
		c.Warnf("couldn't reach the Extension Marketplace: %v\n", err)
	}
	for _, g := range index.Grafts {
		show(g, "")
	}
	var taps []graftTap
	if values != nil {
		taps = readTaps(values)
	}
	for _, tap := range taps {
		tapIndex, tapErr := loadTapIndex(tap)
		if tapErr != nil {
			c.Warnf("%v\n", tapErr)
			continue
		}
		for _, g := range tapIndex.Grafts {
			show(g, tap.Name)
		}
	}
	if err != nil && len(taps) == 0 {
		return fmt.Errorf("couldn't reach the Extension Marketplace: %w", err)
	}
	if matched == 0 {
		c.Printf("no grafts match %q\n", term)
	} else if len(taps) > 0 {
		c.Printf("\ngrafts from taps aren't checked by Orchard; install them with orchardctl graft add <tap>/<id>\n")
	}
	return nil
}

func graftDescribe(c *cli.Context, ref string) error {
	values, _ := cli.LoadValues(c.Env.Values)
	var index marketIndex
	var err error
	tapName, id := "", ref
	if m := tapRefRe.FindStringSubmatch(ref); m != nil && m[3] == "" {
		tapName, id = m[1], m[2]
		tap, ok := graftTap{}, false
		if values != nil {
			tap, ok = findTap(values, tapName)
		}
		if !ok {
			return fmt.Errorf("there is no tap called %s", tapName)
		}
		if index, err = loadTapIndex(tap); err != nil {
			return err
		}
	} else if index, err = loadMarket(values); err != nil {
		return fmt.Errorf("couldn't reach the Extension Marketplace: %w", err)
	}
	g, ok := index.find(id)
	if !ok {
		if tapName != "" {
			return fmt.Errorf("the %s tap has no graft %q", tapName, id)
		}
		return fmt.Errorf("no graft %q in the Extension Marketplace", id)
	}
	platform := ""
	if info, err := instanceInfo(c); err == nil {
		platform = info.Platform
	}
	c.Printf("%s (%s) by %s\n%s\n\n", g.Name, g.ID, g.Publisher, g.Description)
	c.Printf("  tier:      %s\n", tierLabel(g, tapName))
	c.Printf("  publisher: %s\n", g.Publisher)
	if g.Repo != "" {
		c.Printf("  repo:      github.com/%s\n", g.Repo)
	}
	if g.Homepage != "" {
		c.Printf("  homepage:  %s\n", g.Homepage)
	}
	switch {
	case tapName != "":
		tap, _ := findTap(values, tapName)
		c.Printf("\n  %s\n", tapTrustCopy(tapName, tap.URL))
	case g.Tier == "community":
		c.Printf("\n  %s\n", communityCopy(g.Publisher, g.Repo))
	}
	c.Printf("\n")
	sort.Slice(g.Versions, func(i, j int) bool { return versionLess(g.Versions[j].Version, g.Versions[i].Version) })
	for _, v := range g.Versions {
		note := ""
		switch {
		case v.Revoked || index.revoked(v.Digest):
			note = "revoked"
		case platform != "" && !satisfiesRange(platform, v.Engines["platform"]):
			note = "needs Orchard " + v.Engines["platform"]
		case platform != "":
			note = "compatible"
		}
		signed := "unsigned"
		if v.Signed {
			signed = "signed"
		}
		c.Printf("  %-10s %-9s %s\n", v.Version, signed, note)
	}
	return nil
}

func graftList(c *cli.Context) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	specs := readGraftSpecs(values)
	if len(specs) == 0 {
		c.Printf("no grafts installed. Browse with: orchardctl graft search\n")
		return nil
	}
	info, infoErr := instanceInfo(c)
	running := map[string]string{}
	if infoErr == nil {
		for _, g := range info.Installed {
			running[g.ID] = g.Version
		}
	}
	for _, s := range specs {
		state := "not running yet (run orchardctl update)"
		if v, ok := running[s.ID]; ok && v == s.Version {
			state = "running"
		} else if ok {
			state = "running " + v + ", update pending"
		}
		source := "marketplace"
		if s.Tap != "" {
			source = "tap:" + s.Tap
		} else if strings.HasPrefix(s.Source, "orchard://") {
			source = "uploaded file"
		} else if s.Source != "" {
			source = s.Source
		}
		c.Printf("%-24s %-10s %-14s %s\n", s.ID, s.Version, source, state)
	}
	if infoErr != nil {
		c.Warnf("couldn't ask the server what is running: %v\n", infoErr)
	}
	if logs, err := c.KubectlOut("logs", "deploy/server", "-c", "server", "--tail", "4000"); err == nil {
		var lines []string
		for _, line := range strings.Split(logs, "\n") {
			if strings.Contains(line, "[Grafts]") {
				lines = append(lines, strings.TrimSpace(line))
			}
		}
		if len(lines) > 0 {
			c.Printf("\nlatest graft messages from the server:\n")
			for _, l := range lines[max(0, len(lines)-8):] {
				c.Printf("  %s\n", l)
			}
		}
	}
	return nil
}

func readLocalManifest(archive []byte) (graftManifest, []byte, error) {
	var manifest graftManifest
	var chart bytes.Buffer
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return manifest, nil, fmt.Errorf("not a .graft file: %w", err)
	}
	tr := tar.NewReader(gz)
	found := false
	chartWriter := tar.NewWriter(&chart)
	hasChart := false
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return manifest, nil, err
		}
		switch {
		case hdr.Name == "graft.json":
			if err := json.NewDecoder(tr).Decode(&manifest); err != nil {
				return manifest, nil, fmt.Errorf("graft.json: %w", err)
			}
			found = true
		case strings.HasPrefix(hdr.Name, "chart/") && hdr.Typeflag == tar.TypeReg:
			hasChart = true
			body, err := io.ReadAll(tr)
			if err != nil {
				return manifest, nil, err
			}
			_ = chartWriter.WriteHeader(&tar.Header{Name: strings.TrimPrefix(hdr.Name, "chart/"), Mode: 0o644, Size: int64(len(body))})
			_, _ = chartWriter.Write(body)
		}
	}
	_ = chartWriter.Close()
	if !found {
		return manifest, nil, errors.New("archive has no graft.json")
	}
	if !hasChart {
		return manifest, nil, nil
	}
	return manifest, chart.Bytes(), nil
}

func download(url string) ([]byte, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %s", url, res.Status)
	}
	return io.ReadAll(res.Body)
}

func sha256Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func resolveSpec(c *cli.Context, values *cli.Values, arg string) (graftSpec, []byte, error) {
	if strings.HasPrefix(arg, "https://") {
		archive, err := download(arg)
		if err != nil {
			return graftSpec{}, nil, err
		}
		manifest, _, err := readLocalManifest(archive)
		if err != nil {
			return graftSpec{}, nil, err
		}
		return graftSpec{ID: manifest.ID, Version: manifest.Version, Digest: sha256Digest(archive), Source: arg}, archive, nil
	}
	if m := tapRefRe.FindStringSubmatch(arg); m != nil {
		if _, err := os.Stat(arg); err != nil {
			spec, err := resolveTapSpec(values, m[1], m[2], m[3], func() (string, error) {
				info, err := instanceInfo(c)
				return info.Platform, err
			})
			return spec, nil, err
		}
	}
	if strings.HasSuffix(arg, ".graft") || strings.ContainsAny(arg, "/\\") {
		archive, err := os.ReadFile(arg)
		if err != nil {
			return graftSpec{}, nil, err
		}
		manifest, _, err := readLocalManifest(archive)
		if err != nil {
			return graftSpec{}, nil, err
		}
		c.Printf("uploading %s %s into Orchard's database...\n", manifest.ID, manifest.Version)
		out, err := serverExec(c, bytes.NewReader(archive), nil, "store")
		if err != nil {
			return graftSpec{}, nil, err
		}
		var stored struct {
			Digest string `json:"digest"`
			Source string `json:"source"`
		}
		if err := json.Unmarshal(out, &stored); err != nil {
			return graftSpec{}, nil, err
		}
		return graftSpec{ID: manifest.ID, Version: manifest.Version, Digest: stored.Digest, Source: stored.Source}, archive, nil
	}
	id, version, _ := strings.Cut(arg, "@")
	index, err := loadMarket(values)
	if err != nil {
		return graftSpec{}, nil, fmt.Errorf("couldn't reach the Extension Marketplace: %w", err)
	}
	g, ok := index.find(id)
	if !ok {
		return graftSpec{}, nil, fmt.Errorf("no graft %q in the Extension Marketplace", id)
	}
	chosen, err := pickVersion(g, version, index, func() (string, error) {
		info, err := instanceInfo(c)
		return info.Platform, err
	})
	if err != nil {
		return graftSpec{}, nil, err
	}
	spec := graftSpec{ID: id, Version: chosen.Version, Digest: chosen.Digest}
	defaultURL := fmt.Sprintf("%s/grafts/%s/%s/%s-%s.graft", graftMarketURL(values), id, chosen.Version, id, chosen.Version)
	if chosen.URL != "" && chosen.URL != defaultURL {
		spec.Source = chosen.URL
	}
	return spec, nil, nil
}

func checkSpec(c *cli.Context, values *cli.Values, spec graftSpec, rehearse bool) (graftCheck, error) {
	var report graftCheck
	raw, _ := json.Marshal(spec)
	args := []string{"check", string(raw)}
	if rehearse {
		args = append(args, "--dry-run")
	}
	out, err := serverExec(c, nil, graftTrustEnv(values), args...)
	if err != nil {
		return report, err
	}
	return report, json.Unmarshal(out, &report)
}

func printCheck(c *cli.Context, values *cli.Values, spec graftSpec, report graftCheck, prev *graftSpec) {
	m := report.Manifest
	verb := "Install"
	if prev != nil {
		verb = fmt.Sprintf("Upgrade from %s to", prev.Version)
	}
	c.Printf("\n%s %s %s by %s\n", verb, m.Name, m.Version, m.Publisher)
	if m.Description != "" {
		c.Printf("  %s\n", m.Description)
	}
	c.Printf("\n  %s\n", graftTrustWarning)
	c.Printf("  %s\n", signatureCopy(values, spec, report.Signature))
	if len(m.Capabilities) > 0 {
		c.Printf("\n  asks for:        %s\n", strings.Join(m.Capabilities, ", "))
	}
	var reads []string
	for table, cols := range m.Database.CoreReads {
		reads = append(reads, fmt.Sprintf("%s(%s)", table, strings.Join(cols, ", ")))
	}
	if len(reads) > 0 {
		sort.Strings(reads)
		c.Printf("  reads:           %s\n", strings.Join(reads, "; "))
	}
	if len(m.Database.Adopts) > 0 {
		c.Printf("  takes over:      %s (moved out of Orchard's own schema, kept readable under the old names)\n", strings.Join(m.Database.Adopts, ", "))
	}
	var aliases []string
	for kind, list := range m.Claims {
		if strings.HasSuffix(kind, "Aliases") {
			for _, a := range list {
				aliases = append(aliases, "/"+a)
			}
		}
	}
	if len(aliases) > 0 {
		sort.Strings(aliases)
		c.Printf("  paths outside /%s: %s\n", m.ID, strings.Join(aliases, ", "))
	}
	if len(m.Public.Routes) > 0 {
		c.Printf("  open to anyone:  %s\n", strings.Join(m.Public.Routes, ", "))
	}
	for _, s := range report.ShadowedClaim {
		c.Printf("  note: %s %s is already taken by %s and will be skipped\n", s.Kind, s.Value, s.ShadowedBy)
	}
	if len(report.Migrations.Pending) > 0 {
		c.Printf("  database:        %d migrations pending (rehearsal: %s)\n", len(report.Migrations.Pending), report.Migrations.DryRun)
	}
	if len(m.Requires.Kubernetes.Crds) > 0 {
		c.Printf("  needs CRDs:      %s\n", strings.Join(m.Requires.Kubernetes.Crds, ", "))
	}
	for _, p := range report.Problems {
		c.Printf("  problem: %s\n", p)
	}
	c.Printf("\n")
}

func confirm(c *cli.Context, prompt string) bool {
	c.Printf("%s [y/N] ", prompt)
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes"
}

func confirmTyped(c *cli.Context, prompt, want string) bool {
	c.Printf("%s\nType %q to continue: ", prompt, want)
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimSpace(answer) == want
}

func checkCrds(c *cli.Context, crds []string) []string {
	var missing []string
	for _, crd := range crds {
		if _, err := c.Capture("kubectl", "get", "crd", crd); err != nil {
			missing = append(missing, crd)
		}
	}
	return missing
}

func installChart(c *cli.Context, id string, chartTar []byte) error {
	if len(chartTar) == 0 {
		return nil
	}
	dir, err := os.MkdirTemp("", "graft-chart-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	tr := tar.NewReader(bytes.NewReader(chartTar))
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.Clean("/"+hdr.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			return err
		}
	}
	c.Printf("installing the %s cluster chart as helm release orchard-graft-%s...\n", id, id)
	return c.Run("helm", append([]string{"upgrade", "--install", "orchard-graft-" + id, dir, "--namespace", c.Env.Namespace, "--wait", "--timeout", "10m"}, clientSideApply(c)...)...)
}

func dbPrimary(c *cli.Context, values *cli.Values) (string, string, error) {
	if enabled, ok := values.Get("postgres.enabled").(bool); ok && !enabled {
		return "", "", errors.New("Orchard uses an external database here, so orchardctl can't snapshot it; back it up yourself and pass --no-snapshot")
	}
	name, _ := values.Get("postgres.name").(string)
	if name == "" {
		name = "orchard-db"
	}
	database, _ := values.Get("postgres.database").(string)
	if database == "" {
		database = "orchard"
	}
	for _, selector := range []string{"cnpg.io/cluster=" + name + ",cnpg.io/instanceRole=primary", "cnpg.io/cluster=" + name + ",role=primary"} {
		out, err := c.KubectlOut("get", "pods", "-l", selector, "-o", "jsonpath={.items[0].metadata.name}")
		if err == nil && strings.TrimSpace(out) != "" {
			return strings.TrimSpace(out), database, nil
		}
	}
	return "", "", fmt.Errorf("couldn't find the primary of database cluster %s", name)
}

func graftSchemaName(id string) string {
	return "ext_" + strings.ReplaceAll(id, "-", "_")
}

func snapshot(c *cli.Context, values *cli.Values, id string) (string, error) {
	pod, database, err := dbPrimary(c, values)
	if err != nil {
		return "", err
	}
	dump, err := c.KubectlOut("exec", pod, "-c", "postgres", "--", "pg_dump", "-d", database, "-n", graftSchemaName(id), "--no-owner", "--no-privileges")
	if err != nil {
		return "", fmt.Errorf("pg_dump failed: %w", err)
	}
	ledger, err := serverExec(c, nil, nil, "ledger", id)
	if err != nil {
		return "", err
	}
	root := filepath.Join(c.Env.StateDir, graftSnapshotDirectory, id)
	dir := filepath.Join(root, time.Now().UTC().Format("20060102T150405Z"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "schema.sql"), []byte(dump), 0o600); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "ledger.json"), ledger, 0o600); err != nil {
		return "", err
	}
	entries, _ := os.ReadDir(root)
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > graftSnapshotsKept {
		_ = os.RemoveAll(filepath.Join(root, names[0]))
		names = names[1:]
	}
	return dir, nil
}

func restoreSnapshot(c *cli.Context, values *cli.Values, id, dir string) error {
	pod, database, err := dbPrimary(c, values)
	if err != nil {
		return err
	}
	dump, err := os.ReadFile(filepath.Join(dir, "schema.sql"))
	if err != nil {
		return err
	}
	ledger, err := os.ReadFile(filepath.Join(dir, "ledger.json"))
	if err != nil {
		return err
	}
	script := fmt.Sprintf("BEGIN;\nDROP SCHEMA IF EXISTS %q CASCADE;\n%s\nCOMMIT;\n", graftSchemaName(id), dump)
	cmd := exec.Command("kubectl", "-n", c.Env.Namespace, "exec", "-i", pod, "-c", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-d", database)
	cmd.Env = append(os.Environ(), "KUBECONFIG="+c.Env.Kubeconfig)
	cmd.Stdin = strings.NewReader(script)
	cmd.Stdout = c.Stdout
	cmd.Stderr = c.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("restoring %s failed, nothing was changed: %w", id, err)
	}
	_, err = serverExec(c, bytes.NewReader(ledger), nil, "ledger-restore", id)
	return err
}

func historyPath(c *cli.Context) string {
	return filepath.Join(c.Env.StateDir, graftHistoryFile)
}

func loadHistory(c *cli.Context) map[string][]graftHistoryEntry {
	out := map[string][]graftHistoryEntry{}
	raw, err := os.ReadFile(historyPath(c))
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func saveHistory(c *cli.Context, history map[string][]graftHistoryEntry) error {
	raw, err := json.MarshalIndent(history, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(historyPath(c), raw, 0o600)
}

func graftAdd(c *cli.Context, arg string, flags map[string]bool, apply bool) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	spec, archive, err := resolveSpec(c, values, arg)
	if err != nil {
		return err
	}
	return installSpec(c, values, spec, archive, flags, apply)
}

func installSpec(c *cli.Context, values *cli.Values, spec graftSpec, archive []byte, flags map[string]bool, apply bool) error {
	specs := readGraftSpecs(values)
	var prev *graftSpec
	for _, s := range specs {
		if s.ID == spec.ID {
			copied := s
			prev = &copied
		}
	}
	if prev != nil && prev.Tap != spec.Tap {
		return fmt.Errorf("%s is already installed from %s; remove it first with orchardctl graft remove %s", spec.ID, specOrigin(*prev), spec.ID)
	}
	if prev != nil && prev.Version == spec.Version && prev.Digest == spec.Digest {
		c.Printf("%s %s is already in your values\n", spec.ID, spec.Version)
		return nil
	}
	report, err := checkSpec(c, values, spec, false)
	if err != nil {
		return err
	}
	printCheck(c, values, spec, report, prev)
	if missing := checkCrds(c, report.Manifest.Requires.Kubernetes.Crds); len(missing) > 0 {
		report.Problems = append(report.Problems, "missing CRDs: "+strings.Join(missing, ", "))
		c.Printf("  problem: missing CRDs: %s\n", strings.Join(missing, ", "))
	}
	if len(report.Problems) > 0 {
		return errors.New("not installing: fix the problems above first")
	}
	if flags["dry-run"] {
		c.Printf("dry run: everything checks out and nothing was changed\n")
		return nil
	}
	if !flags["yes"] && !confirm(c, fmt.Sprintf("%s %s?", map[bool]string{true: "Upgrade", false: "Install"}[prev != nil], report.Manifest.Name)) {
		return errors.New("cancelled")
	}
	if len(report.Migrations.Pending) > 0 {
		rehearsal, err := checkSpec(c, values, spec, true)
		if err != nil {
			return err
		}
		if len(rehearsal.Problems) > 0 {
			return fmt.Errorf("not installing: %s", strings.Join(rehearsal.Problems, "; "))
		}
	}
	snapshotDir := ""
	if prev != nil && len(report.Migrations.Pending) > 0 && !flags["no-snapshot"] {
		dir, err := snapshot(c, values, spec.ID)
		if err != nil {
			return fmt.Errorf("couldn't snapshot %s before migrating, nothing was changed: %w", spec.ID, err)
		}
		snapshotDir = dir
		c.Printf("saved a snapshot of %s's data to %s\n", spec.ID, dir)
	}
	if archive == nil && strings.TrimSpace(report.Digest) != "" {
		url := spec.Source
		if tap, ok := findTap(values, spec.Tap); ok && url == "" {
			url = tapArtifactURL(tap, spec.ID, spec.Version)
		}
		if url == "" {
			url = fmt.Sprintf("%s/grafts/%s/%s/%s-%s.graft", graftMarketURL(values), spec.ID, spec.Version, spec.ID, spec.Version)
		}
		if !strings.HasPrefix(url, "orchard://") {
			if body, err := download(url); err == nil && sha256Digest(body) == report.Digest {
				archive = body
			}
		}
	}
	if archive != nil {
		if _, chart, err := readLocalManifest(archive); err == nil {
			if err := installChart(c, spec.ID, chart); err != nil {
				return err
			}
		}
	}
	if prev != nil {
		history := loadHistory(c)
		history[spec.ID] = append(history[spec.ID], graftHistoryEntry{Spec: *prev, Replaced: time.Now().UTC().Format(time.RFC3339), Snapshot: snapshotDir})
		if err := saveHistory(c, history); err != nil {
			return err
		}
	}
	specs, _ = upsertSpec(specs, spec)
	writeGraftSpecs(values, specs)
	if err := values.Save(); err != nil {
		return err
	}
	c.Printf("%s %s is in your values.\n", spec.ID, spec.Version)
	if !apply {
		c.Printf("Run orchardctl update to roll it out (or pass --apply next time).\n")
	}
	return maybeApply(c, apply)
}

func graftUpgrade(c *cli.Context, ids []string, flags map[string]bool, apply bool) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	specs := readGraftSpecs(values)
	if len(specs) == 0 {
		c.Printf("no grafts installed\n")
		return nil
	}
	index, marketErr := loadMarket(values)
	info, err := instanceInfo(c)
	if err != nil {
		return err
	}
	tapIndexes := map[string]marketIndex{}
	changed := false
	for _, s := range specs {
		if len(ids) > 0 && !contains(ids, s.ID) {
			continue
		}
		if strings.HasPrefix(s.Source, "orchard://") {
			c.Printf("%s was installed from a file; upgrade it with orchardctl graft add <newer file>\n", s.ID)
			continue
		}
		source := index
		if s.Tap != "" {
			tapIndex, ok := tapIndexes[s.Tap]
			if !ok {
				tap, found := findTap(values, s.Tap)
				if !found {
					c.Warnf("%s comes from the %s tap, which is no longer configured\n", s.ID, s.Tap)
					continue
				}
				loaded, err := loadTapIndex(tap)
				if err != nil {
					c.Warnf("%v\n", err)
					continue
				}
				tapIndex = loaded
				tapIndexes[s.Tap] = tapIndex
			}
			source = tapIndex
		} else if marketErr != nil {
			return fmt.Errorf("couldn't reach the Extension Marketplace: %w", marketErr)
		}
		g, ok := source.find(s.ID)
		if !ok {
			continue
		}
		v, ok := newestCompatible(g, info.Platform, source)
		if !ok || !versionLess(s.Version, v.Version) {
			c.Printf("%s %s is up to date\n", s.ID, s.Version)
			continue
		}
		next := graftSpec{ID: s.ID, Version: v.Version, Digest: v.Digest, Tap: s.Tap}
		if err := installSpec(c, values, next, nil, flags, false); err != nil {
			return err
		}
		changed = true
	}
	if changed {
		return maybeApply(c, apply)
	}
	return nil
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func graftRemove(c *cli.Context, id string, purge, apply bool) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	specs := readGraftSpecs(values)
	var kept []graftSpec
	found := false
	for _, s := range specs {
		if s.ID == id {
			found = true
			continue
		}
		kept = append(kept, s)
	}
	if !found {
		return fmt.Errorf("%s isn't installed", id)
	}
	if info, err := instanceInfo(c); err == nil {
		for _, g := range info.Installed {
			if _, needs := g.Requires[id]; needs && g.ID != id {
				return fmt.Errorf("%s depends on %s; remove %s first", g.ID, id, g.ID)
			}
		}
	}
	if purge {
		if !apply {
			return errors.New("--purge deletes data after the rollout, so it needs --apply")
		}
		if !confirmTyped(c, fmt.Sprintf("This deletes everything %s stored, including its database schema %s. It can't be undone.", id, graftSchemaName(id)), id) {
			return errors.New("cancelled")
		}
	}
	writeGraftSpecs(values, kept)
	if err := values.Save(); err != nil {
		return err
	}
	c.Printf("removed %s from your values; its data is kept unless you purge it\n", id)
	if err := maybeApply(c, apply); err != nil {
		return err
	}
	if _, err := c.Capture("helm", "status", "orchard-graft-"+id, "-n", c.Env.Namespace); err == nil {
		c.Printf("the cluster chart orchard-graft-%s is still installed; remove it with: helm uninstall orchard-graft-%s -n %s\n", id, id, c.Env.Namespace)
	}
	if !purge {
		return nil
	}
	if _, err := serverExec(c, nil, nil, "purge", id); err != nil {
		return err
	}
	c.Printf("purged %s's data\n", id)
	return nil
}

func graftPool(c *cli.Context, args []string, apply bool) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	id := args[0]
	path := graftSettingsPath + ".pools." + id
	if len(args) == 1 {
		if n := values.Get(path); n != nil {
			c.Printf("%s may open %v database connections per pod (set in your values)\n", id, n)
		} else {
			c.Printf("%s uses the pool size it asks for in graft.json (3 when it asks for nothing)\n", id)
		}
		return nil
	}
	installed := false
	for _, s := range readGraftSpecs(values) {
		if s.ID == id {
			installed = true
		}
	}
	if !installed {
		return fmt.Errorf("%s isn't installed", id)
	}
	if args[1] == "default" {
		values.Unset(path)
		c.Printf("%s goes back to the pool size it asks for\n", id)
	} else {
		n, err := strconv.Atoi(args[1])
		if err != nil || n < 1 || n > 50 {
			return errors.New("the pool size is a whole number from 1 to 50, or default")
		}
		if err := values.Set(path, args[1]); err != nil {
			return err
		}
		c.Printf("%s may now open %d database connections per pod; Instance admin, under Grafts, shows how that adds up across pods\n", id, n)
	}
	if err := values.Save(); err != nil {
		return err
	}
	return maybeApply(c, apply)
}

func graftRollback(c *cli.Context, id string, flags map[string]bool, apply bool) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	history := loadHistory(c)
	entries := history[id]
	if len(entries) == 0 {
		return fmt.Errorf("no earlier version of %s on record", id)
	}
	last := entries[len(entries)-1]
	current := ""
	for _, s := range readGraftSpecs(values) {
		if s.ID == id {
			current = s.Version
		}
	}
	message := fmt.Sprintf("Roll %s back from %s to %s.", id, current, last.Spec.Version)
	if last.Snapshot != "" {
		message += fmt.Sprintf(" Its data goes back to the snapshot from %s; anything %s saved since then is lost.", filepath.Base(last.Snapshot), id)
	}
	if !flags["yes"] && !confirmTyped(c, message, id) {
		return errors.New("cancelled")
	}
	if last.Snapshot != "" {
		if err := restoreSnapshot(c, values, id, last.Snapshot); err != nil {
			return err
		}
		c.Printf("restored %s's data from %s\n", id, last.Snapshot)
	}
	specs, _ := upsertSpec(readGraftSpecs(values), last.Spec)
	writeGraftSpecs(values, specs)
	if err := values.Save(); err != nil {
		return err
	}
	history[id] = entries[:len(entries)-1]
	if err := saveHistory(c, history); err != nil {
		return err
	}
	c.Printf("%s is back to %s in your values\n", id, last.Spec.Version)
	return maybeApply(c, apply)
}

func specOrigin(s graftSpec) string {
	switch {
	case s.Tap != "":
		return "the " + s.Tap + " tap"
	case strings.HasPrefix(s.Source, "orchard://"):
		return "an uploaded file"
	case s.Source != "":
		return s.Source
	}
	return "the Extension Marketplace"
}
