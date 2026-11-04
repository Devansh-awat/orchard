package commands

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

type addon struct {
	release   string
	namespace string
	chart     string
	repo      string
	crds      bool
	values    []string
}

var addons = []addon{
	{
		release:   "traefik",
		namespace: "traefik",
		chart:     "traefik",
		repo:      "https://traefik.github.io/charts",
		crds:      true,
	},
	{
		release:   "cnpg",
		namespace: "cnpg-system",
		chart:     "cloudnative-pg",
		repo:      "https://cloudnative-pg.github.io/charts",
		values:    []string{"config.data.ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true"},
	},
	{
		release:   "cert-manager",
		namespace: "cert-manager",
		chart:     "cert-manager",
		repo:      "https://charts.jetstack.io",
	},
}

func chartMajor(version string) (int, error) {
	major, _, _ := strings.Cut(strings.TrimPrefix(version, "v"), ".")
	return strconv.Atoi(major)
}

func addonInstalledVersion(listing []byte, release, chart string) (string, bool, error) {
	var releases []struct {
		Name  string `json:"name"`
		Chart string `json:"chart"`
	}
	if err := json.Unmarshal(listing, &releases); err != nil {
		return "", false, err
	}
	for _, r := range releases {
		if r.Name == release {
			version, ok := strings.CutPrefix(r.Chart, chart+"-")
			if !ok {
				return "", false, fmt.Errorf("%s runs chart %s, not %s", release, r.Chart, chart)
			}
			return version, true, nil
		}
	}
	return "", false, nil
}

func chartVersionFromMetadata(metadata string) (string, error) {
	for _, line := range strings.Split(metadata, "\n") {
		if version, ok := strings.CutPrefix(line, "version: "); ok {
			return strings.Trim(strings.TrimSpace(version), `"'`), nil
		}
	}
	return "", fmt.Errorf("no version in the chart metadata")
}

func addonAction(installed, latest string) (upgrade bool, majorBehind bool, err error) {
	if installed == latest {
		return false, false, nil
	}
	have, err := chartMajor(installed)
	if err != nil {
		return false, false, fmt.Errorf("chart version %q: %w", installed, err)
	}
	want, err := chartMajor(latest)
	if err != nil {
		return false, false, fmt.Errorf("chart version %q: %w", latest, err)
	}
	if want < have {
		return false, false, nil
	}
	if want > have {
		return false, true, nil
	}
	return true, false, nil
}

func upgradeAddon(c *cli.Context, a addon, rollback []string) error {
	listing, err := c.Capture("helm", "list", "--namespace", a.namespace, "--filter", "^"+a.release+"$", "-o", "json")
	if err != nil {
		return err
	}
	installed, found, err := addonInstalledVersion([]byte(listing), a.release, a.chart)
	if err != nil || !found {
		return err
	}
	metadata, err := c.Capture("helm", "show", "chart", a.chart, "--repo", a.repo)
	if err != nil {
		return fmt.Errorf("couldn't read the latest chart: %w", err)
	}
	latest, err := chartVersionFromMetadata(metadata)
	if err != nil {
		return err
	}
	upgrade, majorBehind, err := addonAction(installed, latest)
	if err != nil {
		return err
	}
	if majorBehind {
		c.Warnf("note: %s %s is out, and a new major version needs a person. Current: %s. Read its upgrade notes, then re-run the installer.\n", a.chart, latest, installed)
		return nil
	}
	if !upgrade {
		return nil
	}

	c.Printf("%s: %s to %s\n", a.release, installed, latest)
	args := []string{
		"upgrade", a.release, a.chart,
		"--repo", a.repo,
		"--namespace", a.namespace,
		"--version", latest,
		"--reuse-values",
		"--wait",
		"--timeout", "5m",
	}
	for _, value := range a.values {
		args = append(args, "--set-string", value)
	}
	args = append(args, rollback...)
	args = append(args, clientSideApply(c)...)

	if a.crds {
		crds, err := c.Capture("helm", "show", "crds", a.chart, "--repo", a.repo, "--version", latest)
		if err != nil {
			return fmt.Errorf("couldn't read the %s CRDs: %w", a.chart, err)
		}
		if strings.TrimSpace(crds) != "" {
			if _, err := c.CaptureWithInput(crds, "kubectl", "apply", "--server-side", "--force-conflicts", "-f", "-"); err != nil {
				return fmt.Errorf("couldn't apply the %s CRDs: %w", a.chart, err)
			}
		}
	}
	return c.Run("helm", args...)
}

func helmRollbackFlag(c *cli.Context) []string {
	version, err := c.Capture("helm", "version", "--short")
	if err == nil && strings.HasPrefix(strings.TrimSpace(version), "v4.") {
		return []string{"--rollback-on-failure"}
	}
	return []string{"--atomic"}
}

func upgradeAddons(c *cli.Context) {
	if c.Env.AddonUpdates == "off" {
		return
	}
	rollback := helmRollbackFlag(c)
	for _, a := range addons {
		if err := upgradeAddon(c, a, rollback); err != nil {
			c.Warnf("note: %s wasn't updated: %s\n", a.release, err)
		}
	}
}
