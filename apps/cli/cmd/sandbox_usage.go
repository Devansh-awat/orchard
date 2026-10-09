package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/hackclub/orchard/cli/internal/output"
)

func sandboxUsageCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "usage <sandbox>",
		Short: "Show a machine's CPU, memory, disk and time limits",
		Long: "Usage shows live CPU, memory and disk against the machine's limits, active CPU and network " +
			"(Vercel), plus uptime, when the machine stops if idle, " +
			"its max lifetime and how many machines the owner has against their cap. Unmeasurable values are omitted.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), sandboxPath(str(sb["id"]), "usage"), &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV(sandboxUsagePairs(raw, time.Now()))
			return nil
		},
	}
}

func usageNumber(m map[string]any, key string) (float64, bool) {
	v, ok := m[key].(float64)
	return v, ok
}

func usageOf(used string, limit string) string {
	switch {
	case used != "" && limit != "":
		return used + " of " + limit
	case used != "":
		return used
	case limit != "":
		return "limit " + limit
	}
	return ""
}

func usageBytes(m map[string]any, key string) string {
	if v, ok := usageNumber(m, key); ok {
		return quotaHumanBytes(v)
	}
	return ""
}

func usageCores(m map[string]any, key string) string {
	v, ok := usageNumber(m, key)
	if !ok {
		return ""
	}
	if v >= 1000 {
		return fmt.Sprintf("%.2g cores", v/1000)
	}
	return fmt.Sprintf("%.0fm", v)
}

func usageCoreCount(m map[string]any, key string) string {
	v, ok := usageNumber(m, key)
	if !ok {
		return ""
	}
	if v == 1 {
		return "1 core"
	}
	return fmt.Sprintf("%g cores", v)
}

func usageSpan(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	d = d.Round(time.Minute)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h >= 24 {
		return fmt.Sprintf("%dd %dh", h/24, h%24)
	}
	if h > 0 {
		return fmt.Sprintf("%dh %02dm", h, m)
	}
	return fmt.Sprintf("%dm", m)
}

func usageUntil(m map[string]any, key string, now time.Time) string {
	s, _ := m[key].(string)
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return ""
	}
	return "in " + usageSpan(t.Sub(now))
}

func sandboxUsagePairs(raw map[string]any, now time.Time) [][2]string {
	var rows [][2]string
	add := func(k, v string) {
		if v != "" {
			rows = append(rows, [2]string{k, v})
		}
	}
	add("runner", pick(raw, "runner"))
	add("status", output.Status(pick(raw, "status")))
	if up, ok := usageNumber(raw, "uptimeSeconds"); ok {
		add("running for", usageSpan(time.Duration(up)*time.Second))
	}
	if k8s := quotaSub(raw, "kubernetes"); k8s != nil {
		cpu := quotaSub(k8s, "cpu")
		add("cpu", usageOf(usageCores(cpu, "usedMillicores"), usageCores(cpu, "limitMillicores")))
		add("cpu request", usageCores(cpu, "requestMillicores"))
		mem := quotaSub(k8s, "memory")
		add("memory", usageOf(usageBytes(mem, "usedBytes"), usageBytes(mem, "limitBytes")))
		disk := quotaSub(k8s, "disk")
		add("disk", usageOf(usageBytes(disk, "usedBytes"), usageBytes(disk, "capacityBytes")))
	}
	if v := quotaSub(raw, "vercel"); v != nil {
		cpu := quotaSub(v, "cpu")
		total := usageCoreCount(cpu, "totalCores")
		if total == "" {
			total = usageCoreCount(v, "vcpus")
		}
		used := usageCoreCount(cpu, "usedCores")
		if u, ok := usageNumber(cpu, "usedCores"); ok && total != "" {
			used = fmt.Sprintf("%g", u)
		}
		add("cpu", usageOf(used, total))
		mem := quotaSub(v, "memory")
		memTotal := usageBytes(mem, "totalBytes")
		if memTotal == "" {
			memTotal = usageBytes(v, "memoryBytes")
		}
		add("memory", usageOf(usageBytes(mem, "usedBytes"), memTotal))
		if ms, ok := usageNumber(v, "activeCpuMs"); ok {
			add("active cpu", (time.Duration(ms) * time.Millisecond).Round(time.Second).String())
		}
		add("network out", usageBytes(v, "networkEgressBytes"))
		add("network in", usageBytes(v, "networkIngressBytes"))
		disk := quotaSub(v, "disk")
		if usageBytes(disk, "usedBytes") != "" {
			add("disk", usageOf(usageBytes(disk, "usedBytes"), usageBytes(disk, "capacityBytes")))
		}
	}
	add("stops if idle", usageUntil(raw, "stopsAt", now))
	add("max lifetime ends", usageUntil(raw, "lifetimeEndsAt", now))
	if machines := quotaSub(raw, "machines"); machines != nil {
		count, _ := usageNumber(machines, "count")
		if limit, ok := usageNumber(machines, "limit"); ok {
			add("machines", fmt.Sprintf("%g of %g", count, limit))
		} else {
			add("machines", fmt.Sprintf("%g", count))
		}
	}
	return rows
}
