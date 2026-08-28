package cmd

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func quotaCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "quota",
		GroupID: groupResources,
		Aliases: []string{"quotas"},
		Short:   "Inspect resource quotas and usage for the org",
	}
	c.AddCommand(
		quotaShowCmd(),
		quotaMeCmd(),
		quotaMembersCmd(),
		quotaProjectsCmd(),
	)
	return c
}

func quotaPath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/quota"
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

// quotaCPU renders millicores; a missing/null value means unlimited.
func quotaCPU(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "unlimited"
	}
	return strconv.FormatFloat(f, 'f', -1, 64) + "m"
}

// quotaMem renders a byte count with binary units; missing/null = unlimited.
func quotaMem(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "unlimited"
	}
	return quotaHumanBytes(f)
}

func quotaHumanBytes(b float64) string {
	for _, u := range []struct {
		mult   float64
		suffix string
	}{{1 << 40, "Ti"}, {1 << 30, "Gi"}, {1 << 20, "Mi"}, {1 << 10, "Ki"}} {
		if b >= u.mult {
			return strings.TrimSuffix(strconv.FormatFloat(b/u.mult, 'f', 1, 64), ".0") + u.suffix
		}
	}
	return strconv.FormatFloat(b, 'f', -1, 64) + "B"
}

// quotaCount renders integral counters (pods, services); missing = unlimited.
func quotaCount(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "unlimited"
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func quotaSub(m map[string]any, key string) map[string]any {
	s, _ := m[key].(map[string]any)
	return s
}

func quotaUsed(used, limit string) string {
	return used + " / " + limit
}

// quotaGetKV fetches one quota endpoint and hands the map to render (JSON mode
// passes the payload through untouched).
func quotaGetKV(short string, sub []string, render func(map[string]any)) *cobra.Command {
	use := "show"
	if len(sub) > 0 {
		use = sub[len(sub)-1]
	}
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), quotaPath(orgID, sub...), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			render(raw)
			return nil
		},
	}
}

func quotaShowCmd() *cobra.Command {
	return quotaGetKV("Show org-wide usage against its caps", nil, func(raw map[string]any) {
		org := quotaSub(raw, "org")
		usage := quotaSub(raw, "usage")
		pairs := [][2]string{
			{"org", pick(org, "name", "id")},
			{"cpu", quotaUsed(quotaCPU(usage["cpuMilli"]), quotaCPU(org["cpuLimitMilli"]))},
			{"memory", quotaUsed(quotaMem(usage["memoryBytes"]), quotaMem(org["memoryLimitBytes"]))},
			{"pods", quotaUsed(quotaCount(usage["pods"]), quotaCount(org["maxPods"]))},
			{"services", quotaUsed(quotaCount(usage["services"]), quotaCount(org["maxServices"]))},
		}
		if org["defaultPodCpuMilli"] != nil {
			pairs = append(pairs, [2]string{"default pod cpu", quotaCPU(org["defaultPodCpuMilli"])})
		}
		if org["defaultPodMemoryBytes"] != nil {
			pairs = append(pairs, [2]string{"default pod memory", quotaMem(org["defaultPodMemoryBytes"])})
		}
		if conns := asList(raw["connections"]); len(conns) > 0 {
			names := make([]string, 0, len(conns))
			for _, c := range conns {
				names = append(names, pick(c, "slug", "name", "id"))
			}
			pairs = append(pairs, [2]string{"quota shared with", strings.Join(names, ", ")})
		}
		output.KV(pairs)
	})
}

// quotaAllowance annotates values inherited from the org default so an
// explicit 0 and "nobody set one" read differently.
func quotaAllowance(val, source string) string {
	if source == "default" {
		return val + " " + output.Dim("(org default)")
	}
	return val
}

func quotaMeCmd() *cobra.Command {
	return quotaGetKV("Show your own allowance, usage, and headroom in the org", []string{"me"}, func(raw map[string]any) {
		allowance := quotaSub(raw, "allowance")
		source := quotaSub(allowance, "source")
		usage := quotaSub(raw, "usage")
		orgCap := quotaSub(raw, "orgCap")
		eff := quotaSub(raw, "effectiveLimit")
		output.KV([][2]string{
			{"cpu allowance", quotaAllowance(quotaCPU(allowance["cpuMilli"]), pick(source, "cpu"))},
			{"cpu used", quotaCPU(usage["cpuMilli"])},
			{"cpu headroom", quotaCPU(eff["cpuMilli"])},
			{"memory allowance", quotaAllowance(quotaMem(allowance["memoryBytes"]), pick(source, "memory"))},
			{"memory used", quotaMem(usage["memoryBytes"])},
			{"memory headroom", quotaMem(eff["memoryBytes"])},
			{"org cpu cap", quotaCPU(orgCap["cpuLimitMilli"])},
			{"org memory cap", quotaMem(orgCap["memoryLimitBytes"])},
		})
		breakdown := asList(usage["breakdown"])
		if len(breakdown) == 0 {
			return
		}
		fmt.Println()
		rows := [][]string{}
		for _, e := range breakdown {
			rows = append(rows, []string{
				pick(e, "kind"),
				pick(e, "name"),
				pick(e, "projectName"),
				quotaCPU(e["cpuMilli"]),
				quotaMem(e["memoryBytes"]),
				pick(e, "replicas"),
			})
		}
		output.Table([]string{"kind", "name", "project", "cpu", "memory", "replicas"}, rows)
	})
}

func quotaMembersCmd() *cobra.Command {
	return quotaGetKV("Show per-member allowances and usage (org admins)", []string{"members"}, func(raw map[string]any) {
		org := quotaSub(raw, "org")
		commitment := quotaSub(raw, "commitment")
		output.KV([][2]string{
			{"org cpu cap", quotaCPU(org["cpuLimitMilli"])},
			{"org memory cap", quotaMem(org["memoryLimitBytes"])},
			{"default allowance", quotaCPU(org["defaultMemberCpuMilli"]) + " cpu, " + quotaMem(org["defaultMemberMemoryBytes"]) + " memory"},
			{"committed", quotaCPU(commitment["cpuMilli"]) + " cpu, " + quotaMem(commitment["memoryBytes"]) + " memory"},
		})
		fmt.Println()
		rows := [][]string{}
		for _, m := range asList(raw["members"]) {
			user := quotaSub(m, "user")
			allowance := quotaSub(m, "allowance")
			usage := quotaSub(m, "usage")
			rows = append(rows, []string{
				pick(user, "username", "email", "id"),
				pick(m, "role"),
				quotaCPU(allowance["cpuMilli"]),
				quotaMem(allowance["memoryBytes"]),
				quotaCPU(usage["cpuMilli"]),
				quotaMem(usage["memoryBytes"]),
			})
		}
		output.Table([]string{"member", "role", "cpu allowance", "mem allowance", "cpu used", "mem used"}, rows)
	})
}

func quotaProjectsCmd() *cobra.Command {
	return quotaGetKV("Show per-project caps and usage (org admins)", []string{"projects"}, func(raw map[string]any) {
		total := quotaSub(raw, "orgTotal")
		output.KV([][2]string{
			{"org cpu used", quotaCPU(total["cpuMilli"])},
			{"org memory used", quotaMem(total["memoryBytes"])},
			{"org pods", quotaCount(total["pods"])},
		})
		fmt.Println()
		rows := [][]string{}
		for _, p := range asList(raw["projects"]) {
			usage := quotaSub(p, "usage")
			rows = append(rows, []string{
				pick(p, "id"),
				pick(p, "name", "slug"),
				quotaUsed(quotaCPU(usage["cpuMilli"]), quotaCPU(p["cpuLimitMilli"])),
				quotaUsed(quotaMem(usage["memoryBytes"]), quotaMem(p["memoryLimitBytes"])),
				quotaUsed(quotaCount(usage["pods"]), quotaCount(p["maxPods"])),
			})
		}
		output.Table([]string{"id", "project", "cpu", "memory", "pods"}, rows)
	})
}
