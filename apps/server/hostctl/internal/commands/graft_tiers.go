package commands

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	graftTapsPath     = graftSettingsPath + ".taps"
	graftTrustPath    = graftSettingsPath + ".trust"
	defaultGraftTrust = "listed"
)

var (
	tapNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	tapRefRe  = regexp.MustCompile(`^([a-z][a-z0-9-]{1,31})/([a-z][a-z0-9-]{1,47})(?:@(.+))?$`)
)

var graftTrustLevels = []struct{ name, meaning string }{
	{"official", "only grafts signed by Orchard"},
	{"listed", "official grafts, community grafts listed in the Extension Marketplace, and publisher keys you added"},
	{"taps", "everything listed allows, plus grafts from the taps you added"},
	{"any", "everything, including unsigned grafts"},
}

type graftTap struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Key  string `json:"key"`
}

type tapManifest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	PublicKey   string `json:"publicKey"`
}

func graftKeyID(publicKey string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKey))
	if err != nil || len(raw) != 32 {
		return "", errors.New("public keys must be 32-byte ed25519 keys in base64")
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:16], nil
}

func readTaps(values *cli.Values) []graftTap {
	var taps []graftTap
	for _, item := range values.List(graftTapsPath) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		tap := graftTap{}
		tap.Name, _ = m["name"].(string)
		tap.URL, _ = m["url"].(string)
		tap.Key, _ = m["key"].(string)
		if tap.Name != "" {
			taps = append(taps, tap)
		}
	}
	return taps
}

func writeTaps(values *cli.Values, taps []graftTap) {
	items := make([]any, 0, len(taps))
	for _, t := range taps {
		items = append(items, map[string]any{"name": t.Name, "url": t.URL, "key": t.Key})
	}
	values.SetList(graftTapsPath, items)
}

func findTap(values *cli.Values, name string) (graftTap, bool) {
	for _, t := range readTaps(values) {
		if t.Name == name {
			return t, true
		}
	}
	return graftTap{}, false
}

func normalizeTrust(value string) string {
	value = strings.TrimSpace(value)
	if value == "signed" || value == "" {
		return defaultGraftTrust
	}
	return value
}

func graftTrust(values *cli.Values) string {
	if values != nil {
		if s, ok := values.Get(graftTrustPath).(string); ok {
			return normalizeTrust(s)
		}
	}
	return defaultGraftTrust
}

func trustAllowsTaps(trust string) bool {
	return trust == "taps" || trust == "any"
}

func tapURL(raw string) (string, error) {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	switch {
	case strings.HasPrefix(u, "https://"):
	case strings.HasPrefix(u, "http://") && os.Getenv("ORCHARD_GRAFTS_ALLOW_HTTP") == "1":
	default:
		return "", errors.New("a tap url must start with https://")
	}
	if len(u) <= len("https://") {
		return "", errors.New("the tap url has no host")
	}
	return u, nil
}

func loadTapIndex(tap graftTap) (marketIndex, error) {
	var index marketIndex
	if err := fetchJSON(tap.URL+"/grafts/index.json", &index); err != nil {
		return index, fmt.Errorf("couldn't read the %s tap: %w", tap.Name, err)
	}
	return index, nil
}

func tapArtifactURL(tap graftTap, id, version string) string {
	return fmt.Sprintf("%s/grafts/%s/%s/%s-%s.graft", tap.URL, id, version, id, version)
}

func graftTapsEnv(values *cli.Values) string {
	taps := readTaps(values)
	if taps == nil {
		taps = []graftTap{}
	}
	raw, _ := json.Marshal(taps)
	return string(raw)
}

func runGraftTap(c *cli.Context, args []string, flags map[string]bool) error {
	if len(args) == 0 {
		return errors.New("usage: orchardctl graft tap add <name> <url> | list | remove <name>")
	}
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	switch args[0] {
	case "add":
		if len(args) != 3 {
			return errors.New("usage: orchardctl graft tap add <name> <url> [--yes]")
		}
		return graftTapAdd(c, values, args[1], args[2], flags["yes"])
	case "list":
		return graftTapList(c, values)
	case "remove":
		if len(args) != 2 {
			return errors.New("usage: orchardctl graft tap remove <name>")
		}
		return graftTapRemove(c, values, args[1])
	default:
		return fmt.Errorf("unknown tap command %q; use add, list or remove", args[0])
	}
}

func graftTapAdd(c *cli.Context, values *cli.Values, name, rawURL string, yes bool) error {
	if !tapNameRe.MatchString(name) {
		return fmt.Errorf("tap name %q must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter", name)
	}
	if _, exists := findTap(values, name); exists {
		return fmt.Errorf("there is already a tap called %s; remove it first or pick another name", name)
	}
	url, err := tapURL(rawURL)
	if err != nil {
		return err
	}
	var manifest tapManifest
	if err := fetchJSON(url+"/tap.json", &manifest); err != nil {
		return fmt.Errorf("couldn't read %s/tap.json: %w", url, err)
	}
	id, err := graftKeyID(manifest.PublicKey)
	if err != nil {
		return fmt.Errorf("%s/tap.json: %w", url, err)
	}
	c.Printf("\nAdd the %s tap\n", name)
	c.Printf("  url:      %s\n", url)
	if manifest.Name != "" && manifest.Name != name {
		c.Printf("  calls itself: %s\n", manifest.Name)
	}
	if manifest.Description != "" {
		c.Printf("  about:    %s\n", manifest.Description)
	}
	c.Printf("  key:      %s\n", id)
	c.Printf("\n  %s\n", tapTrustCopy(name, url))
	c.Printf("  %s\n\n", graftTrustWarning)
	if !yes && !confirm(c, fmt.Sprintf("Trust grafts signed with key %s from the %s tap?", id, name)) {
		return errors.New("cancelled")
	}
	writeTaps(values, append(readTaps(values), graftTap{Name: name, URL: url, Key: strings.TrimSpace(manifest.PublicKey)}))
	if err := values.Save(); err != nil {
		return err
	}
	c.Printf("added the %s tap. Install from it with: orchardctl graft add %s/<id>\n", name, name)
	if trust := graftTrust(values); !trustAllowsTaps(trust) {
		c.Printf("your trust policy is %s, so grafts from taps won't load until you run: orchardctl graft trust taps\n", trust)
	}
	return nil
}

func graftTapList(c *cli.Context, values *cli.Values) error {
	taps := readTaps(values)
	if len(taps) == 0 {
		c.Printf("no taps added. Add one with: orchardctl graft tap add <name> <url>\n")
		return nil
	}
	using := map[string][]string{}
	for _, s := range readGraftSpecs(values) {
		if s.Tap != "" {
			using[s.Tap] = append(using[s.Tap], s.ID)
		}
	}
	for _, t := range taps {
		id, err := graftKeyID(t.Key)
		if err != nil {
			id = "invalid key"
		}
		installed := "nothing installed"
		if len(using[t.Name]) > 0 {
			installed = "installed: " + strings.Join(using[t.Name], ", ")
		}
		c.Printf("%-20s %-16s %-40s %s\n", t.Name, id, t.URL, installed)
	}
	if trust := graftTrust(values); !trustAllowsTaps(trust) {
		c.Printf("\nyour trust policy is %s, so grafts from taps don't load; change it with: orchardctl graft trust taps\n", trust)
	}
	return nil
}

func graftTapRemove(c *cli.Context, values *cli.Values, name string) error {
	if _, ok := findTap(values, name); !ok {
		return fmt.Errorf("there is no tap called %s", name)
	}
	var users []string
	for _, s := range readGraftSpecs(values) {
		if s.Tap == name {
			users = append(users, s.ID)
		}
	}
	if len(users) > 0 {
		return fmt.Errorf("%s is installed from the %s tap; remove it first with orchardctl graft remove", strings.Join(users, ", "), name)
	}
	var kept []graftTap
	for _, t := range readTaps(values) {
		if t.Name != name {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		values.Unset(graftTapsPath)
	} else {
		writeTaps(values, kept)
	}
	if err := values.Save(); err != nil {
		return err
	}
	c.Printf("removed the %s tap\n", name)
	return nil
}

func resolveTapSpec(values *cli.Values, tapName, id, version string, platform func() (string, error)) (graftSpec, error) {
	tap, ok := findTap(values, tapName)
	if !ok {
		return graftSpec{}, fmt.Errorf("there is no tap called %s; add it with orchardctl graft tap add %s <url>", tapName, tapName)
	}
	index, err := loadTapIndex(tap)
	if err != nil {
		return graftSpec{}, err
	}
	g, ok := index.find(id)
	if !ok {
		return graftSpec{}, fmt.Errorf("the %s tap has no graft %q", tapName, id)
	}
	chosen, err := pickVersion(g, version, index, platform)
	if err != nil {
		return graftSpec{}, err
	}
	return graftSpec{ID: id, Version: chosen.Version, Digest: chosen.Digest, Tap: tapName}, nil
}

func pickVersion(g marketGraft, version string, index marketIndex, platform func() (string, error)) (marketVersion, error) {
	var chosen marketVersion
	if version == "" {
		p, err := platform()
		if err != nil {
			return chosen, err
		}
		v, ok := newestCompatible(g, p, index)
		if !ok {
			return chosen, fmt.Errorf("no version of %s works with Orchard %s", g.ID, p)
		}
		chosen = v
	} else {
		for _, v := range g.Versions {
			if v.Version == version {
				chosen = v
			}
		}
		if chosen.Version == "" {
			return chosen, fmt.Errorf("%s has no version %s", g.ID, version)
		}
	}
	if index.revoked(chosen.Digest) || chosen.Revoked {
		return chosen, fmt.Errorf("%s %s has been revoked", g.ID, chosen.Version)
	}
	return chosen, nil
}

func tierLabel(g marketGraft, tap string) string {
	switch {
	case tap != "":
		return "tap:" + tap
	case g.Tier == "community":
		return "community by " + g.Publisher
	default:
		return "official"
	}
}

func communityCopy(publisher, repo string) string {
	return fmt.Sprintf("Published by %s (github.com/%s), not by Orchard. Orchard checked it when it was listed, but doesn't review its updates.", publisher, repo)
}

func tapTrustCopy(name, url string) string {
	return fmt.Sprintf("From the %s tap at %s. Orchard hasn't checked anything in this tap. Install it only if you trust %s.", name, url, name)
}

func graftTier(spec graftSpec, sig *graftSignature) string {
	tier := ""
	if sig != nil && sig.Tier != nil {
		tier = *sig.Tier
	} else if sig != nil && sig.SignedBy != nil {
		tier = *sig.SignedBy
	}
	if spec.Tap != "" && tier != "official" {
		tier = "tap"
	}
	return tier
}

func thirdPartyGraft(spec graftSpec, sig *graftSignature) bool {
	return graftTier(spec, sig) != "official"
}

func confirmThirdParty(c *cli.Context, flags map[string]bool, spec graftSpec, sig *graftSignature, id string) error {
	if !thirdPartyGraft(spec, sig) || flags["allow-third-party"] {
		return nil
	}
	if flags["yes"] {
		return errors.New("this graft wasn't made by Orchard and can take over this server; add --allow-third-party to accept that with --yes")
	}
	if !confirmTyped(c, "This graft wasn't made by Orchard and can take over this server.", id) {
		return errors.New("cancelled")
	}
	return nil
}

func signatureCopy(values *cli.Values, spec graftSpec, sig *graftSignature) string {
	tier := graftTier(spec, sig)
	switch tier {
	case "official":
		return "Signed by Orchard."
	case "community":
		return communityCopy(sig.Publisher, sig.Repo)
	case "tap":
		name := spec.Tap
		if sig != nil && sig.Tap != "" {
			name = sig.Tap
		}
		tap, _ := findTap(values, name)
		return tapTrustCopy(name, tap.URL)
	case "publisher":
		if sig.KeyID != nil {
			return fmt.Sprintf("Signed by publisher key %s.", *sig.KeyID)
		}
		return "Signed by a publisher key you added."
	}
	return graftUnsignedWarning
}

func graftTrustCommand(c *cli.Context, args []string, apply bool) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	current := graftTrust(values)
	if len(args) == 0 {
		c.Printf("trust policy: %s\n\n", current)
		for _, l := range graftTrustLevels {
			marker := " "
			if l.name == current {
				marker = "*"
			}
			c.Printf("%s %-9s %s\n", marker, l.name, l.meaning)
		}
		c.Printf("\nchange it with: orchardctl graft trust <level>\n")
		return nil
	}
	if len(args) != 1 {
		return errors.New("usage: orchardctl graft trust [official|listed|taps|any]")
	}
	next := normalizeTrust(args[0])
	valid := false
	for _, l := range graftTrustLevels {
		if l.name == next {
			valid = true
		}
	}
	if !valid {
		return fmt.Errorf("trust policy %q must be official, listed, taps or any", args[0])
	}
	if err := values.Set(graftTrustPath, next); err != nil {
		return err
	}
	if err := values.Save(); err != nil {
		return err
	}
	c.Printf("trust policy is now %s\n", next)
	if !apply {
		c.Printf("Run orchardctl update to roll it out (or pass --apply next time).\n")
	}
	return maybeApply(c, apply)
}
