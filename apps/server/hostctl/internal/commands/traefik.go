package commands

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	traefikRelease   = "traefik"
	traefikNamespace = "traefik"
	traefikChartRepo = "https://traefik.github.io/charts"
)

func traefikChartVersion(chart string) (string, int, bool) {
	version, ok := strings.CutPrefix(strings.TrimSpace(chart), "traefik-")
	if !ok || version == "" {
		return "", 0, false
	}
	major, err := strconv.Atoi(strings.SplitN(version, ".", 2)[0])
	if err != nil {
		return "", 0, false
	}
	return version, major, true
}

func nested(values map[string]any, path ...string) any {
	var cur any = values
	for _, part := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[part]
	}
	return cur
}

func traefikAccessLogSets(major int, current map[string]any) []string {
	prefix := []string{"accessLog"}
	if major < 41 {
		prefix = []string{"logs", "access"}
	}
	key := strings.Join(prefix, ".")
	want := []struct {
		path  []string
		value any
		set   string
	}{
		{[]string{"enabled"}, true, key + ".enabled=true"},
		{[]string{"format"}, "json", key + ".format=json"},
		{[]string{"fields", "headers", "names", "User-Agent"}, "keep", key + ".fields.headers.names.User-Agent=keep"},
	}
	var sets []string
	for _, w := range want {
		if nested(current, append(append([]string{}, prefix...), w.path...)...) != w.value {
			sets = append(sets, w.set)
		}
	}
	return sets
}

func ensureTraefikAccessLogs(c *cli.Context) {
	out, err := c.Capture("helm", "list", "-n", traefikNamespace, "--filter", "^"+traefikRelease+"$", "-o", "json")
	if err != nil {
		return
	}
	var releases []struct {
		Name  string `json:"name"`
		Chart string `json:"chart"`
	}
	if json.Unmarshal([]byte(out), &releases) != nil || len(releases) == 0 {
		return
	}
	version, major, ok := traefikChartVersion(releases[0].Chart)
	if !ok {
		c.Warnf("note: couldn't tell which Traefik chart is installed (%q); access logs left as they are\n", releases[0].Chart)
		return
	}
	raw, err := c.Capture("helm", "get", "values", traefikRelease, "-n", traefikNamespace, "-o", "json")
	if err != nil {
		c.Warnf("note: couldn't read Traefik's values; access logs left as they are\n")
		return
	}
	current := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &current)
	sets := traefikAccessLogSets(major, current)
	if len(sets) == 0 {
		return
	}
	c.Printf("turning on Traefik's JSON access log, which per-route request stats are read from\n")
	args := []string{"upgrade", traefikRelease, "traefik", "--repo", traefikChartRepo, "--version", version,
		"--namespace", traefikNamespace, "--reuse-values", "--wait", "--timeout", "10m"}
	for _, set := range sets {
		args = append(args, "--set", set)
	}
	if err := c.Run("helm", args...); err != nil {
		c.Warnf("note: Traefik access logs are still off (%s); request stats stay empty until this runs:\n  helm upgrade %s\n", err, strings.Join(args[1:], " "))
	}
}
