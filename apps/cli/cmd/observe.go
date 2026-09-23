package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func observeCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "observe",
		GroupID: groupResources,
		Aliases: []string{"obs"},
		Short:   "Deployment observability: logs, HTTP metrics, errors, runtime",
	}
	c.AddCommand(
		observeOverviewCmd(),
		observeLogsCmd(),
		observeHTTPCmd(),
		observeErrorsCmd(),
		observeRuntimeCmd(),
		observeCapabilitiesCmd(),
		observeActivityCmd(),
	)
	return c
}

func observeActivityCmd() *cobra.Command {
	var kinds string
	var limit *int
	var cursor *string
	var all *bool
	c := &cobra.Command{
		Use:     "activity <deploymentId>",
		Aliases: []string{"timeline"},
		Short:   "Merged activity feed: releases, builds, changes by people, pod transitions, new errors",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			entries := []map[string]any{}
			next := *cursor
			for page := 0; ; page++ {
				if page >= maxPages {
					return errors.New("--all hit the 100-page safety cap")
				}
				q := url.Values{}
				if kinds != "" {
					q.Set("kinds", kinds)
				}
				if *limit > 0 {
					q.Set("limit", strconv.Itoa(*limit))
				}
				if next != "" {
					q.Set("cursor", next)
				}
				var raw map[string]any
				if err := cl.GetJSON(cmd.Context(), observePath(args[0], "timeline")+"?"+q.Encode(), &raw); err != nil {
					return err
				}
				entries = append(entries, asList(raw["entries"])...)
				next = pick(raw, "nextCursor")
				if next == "" || !*all {
					break
				}
			}
			if fmtFlag() == output.FormatJSON {
				out := map[string]any{"entries": entries}
				if next != "" {
					out["nextCursor"] = next
				}
				return output.JSON(out)
			}
			rows := [][]string{}
			for _, e := range entries {
				who := ""
				if a, ok := e["actor"].(map[string]any); ok {
					who = pick(a, "username", "email")
				}
				rows = append(rows, []string{
					pick(e, "at"),
					pick(e, "kind"),
					pick(e, "title"),
					observeTruncate(pick(e, "detail"), 60),
					who,
				})
			}
			output.Table([]string{"at", "kind", "what", "detail", "who"}, rows)
			if next != "" {
				output.Warnf("more entries available: resume with --cursor %s", next)
			}
			return nil
		},
	}
	c.Flags().StringVar(&kinds, "kinds", "", "comma list of audit,build,release,pod,error (default: all)")
	limit, cursor, all = addPageFlags(c)
	return c
}

func observePath(id string, rest ...string) string {
	p := "/observe/deployments/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func observeOverviewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "overview <deploymentId>",
		Short: "Stat strip: uptime, pods, restarts, cpu/mem, request rate, errors, latency",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), observePath(args[0], "overview"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"uptime", observeUptime(str(raw["uptime"]))},
				{"pods", observeOr(pick(raw, "podCount"))},
				{"restarts", observeOr(pick(raw, "restarts"))},
				{"cpu", observeFmt(raw, "cpuPercent", observePercent1Str)},
				{"memory", observeFmt(raw, "memoryPercent", observePercent1Str)},
				{"req/s", observeFmt(raw, "httpRequestRate", observeRateStr)},
				{"error rate", observeFmt(raw, "httpErrorRate", observePercent2Str)},
				{"avg latency", observeFmt(raw, "httpAvgLatency", observeLatencyStr)},
			})
			return nil
		},
	}
}

func observeLogsCmd() *cobra.Command {
	var (
		level, search string
		tail          int
		follow        bool
	)
	c := &cobra.Command{
		Use:   "logs <deploymentId>",
		Short: "Structured logs (level detection, multi-line grouping) with filter and follow",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			q := url.Values{"tailLines": {strconv.Itoa(tail)}}
			if level != "" {
				q.Set("level", level)
			}
			if search != "" {
				q.Set("search", search)
			}
			path := observePath(args[0], "logs", "structured") + "?" + q.Encode()
			asJSON := fmtFlag() == output.FormatJSON
			if follow {
				if level == "" && search == "" && !asJSON {
					if err := followRuntimeLogsSSE(cmd.Context(), cl, args[0], tail); !errors.Is(err, errSSEUnsupported) {
						return err
					}
				}
				fetch := func(ctx context.Context) (string, error) {
					var raw map[string]any
					if err := cl.GetJSON(ctx, path, &raw); err != nil {
						return "", err
					}
					return observeRenderLogEntries(asList(raw["entries"]), asJSON)
				}
				return followLines(cmd.Context(), 3*time.Second, fetch, os.Stdout)
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if asJSON {
				return output.JSON(raw)
			}
			entries := asList(raw["entries"])
			if len(entries) == 0 {
				output.Warnf("no log entries")
				return nil
			}
			text, rerr := observeRenderLogEntries(entries, false)
			if rerr != nil {
				return rerr
			}
			fmt.Print(text)
			return nil
		},
	}
	c.Flags().StringVar(&level, "level", "", "only entries with this level (debug|info|warn|error|fatal)")
	c.Flags().StringVar(&search, "search", "", "only entries containing this substring")
	c.Flags().IntVar(&tail, "tail", 200, "lines of recent logs to scan (max 20000)")
	c.Flags().BoolVar(&follow, "follow", false, "poll every 3s and print new entries")
	return c
}

func observeHTTPCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "http <deploymentId>",
		Short: "HTTP request rate, error rate and latency for the last hour",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), observePath(args[0], "http-metrics"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{}
			empty := true
			for _, s := range []struct {
				key, label string
				format     func(float64) string
			}{
				{"requestRate", "request rate", observeRateStr},
				{"errorRate", "error rate", observePercent2Str},
				{"latencyAvg", "avg latency", observeLatencyStr},
				{"latencyMax", "max latency", observeLatencyStr},
			} {
				val := "-"
				if y, ok := observeSeriesLatest(raw[s.key]); ok {
					val = s.format(y)
					empty = false
				}
				pairs = append(pairs, [2]string{s.label, val})
			}
			if empty {
				output.Warnf("no http metrics (the deployment may have no ingress)")
			}
			output.KV(pairs)
			return nil
		},
	}
}

func observeErrorsCmd() *cobra.Command {
	var window string
	c := &cobra.Command{
		Use:   "errors <deploymentId>",
		Short: "Grouped error log entries with counts and trends",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			minutes, err := observeWindowMinutes(window)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			q := url.Values{"window": {strconv.Itoa(minutes)}}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), observePath(args[0], "errors")+"?"+q.Encode(), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, g := range asList(raw["errors"]) {
				rows = append(rows, []string{
					pick(g, "fingerprint"),
					pick(g, "type"),
					pick(g, "count"),
					pick(g, "trend"),
					pick(g, "lastSeen"),
					observeTruncate(pick(g, "message"), 60),
				})
			}
			output.Table([]string{"fingerprint", "type", "count", "trend", "last seen", "message"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&window, "window", "1h", "time window (15m, 1h, 6h or 24h)")
	return c
}

func observeRuntimeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "runtime <deploymentId>",
		Short: "Detected language/framework (from build logs, image, env vars or dockerfile)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), observePath(args[0], "runtime"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"language", observeOr(pick(raw, "language"))},
				{"framework", observeOr(pick(raw, "framework"))},
				{"version", observeOr(pick(raw, "version"))},
				{"confidence", observeOr(pick(raw, "confidence"))},
				{"detected from", observeOr(pick(raw, "detectedFrom"))},
			})
			return nil
		},
	}
}

func observeCapabilitiesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "capabilities <deploymentId>",
		Short: "Which observability signals are available for this deployment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), observePath(args[0], "capabilities"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"logs", observeOr(pick(raw, "logs"))},
				{"container metrics", observeOr(pick(raw, "containerMetrics"))},
				{"http metrics", observeOr(pick(raw, "httpMetrics"))},
				{"custom metrics", observeOr(pick(raw, "customMetrics"))},
				{"traces", observeOr(pick(raw, "traces"))},
				{"runtime", observeRuntimeSummary(raw["runtime"])},
			})
			return nil
		},
	}
}

var (
	observeErrStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	observeWarnStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	observeInfoStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("39"))
)

func observeRuntimeSummary(v any) string {
	rt, ok := v.(map[string]any)
	if !ok {
		return "-"
	}
	desc := pick(rt, "language")
	if desc == "" || desc == "unknown" {
		return "unknown"
	}
	if fw := pick(rt, "framework"); fw != "" {
		desc += " (" + fw + ")"
	}
	if ver := pick(rt, "version"); ver != "" {
		desc += " " + ver
	}
	return desc
}

// observeRenderLogEntries renders structured log entries either as NDJSON (one
// entry per line, used by --follow in json mode) or as compact
// "ts LEVEL message" lines with continuation lines (stack frames, dumps)
// indented underneath.
func observeRenderLogEntries(entries []map[string]any, asJSON bool) (string, error) {
	var b strings.Builder
	if asJSON {
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		for _, e := range entries {
			if err := enc.Encode(e); err != nil {
				return "", err
			}
		}
		return b.String(), nil
	}
	for _, e := range entries {
		lines := strings.Split(str(e["raw"]), "\n")
		msg := pick(e, "message")
		if msg == "" {
			msg = lines[0]
		}
		b.WriteString(output.Dim(observeLogTime(str(e["timestamp"]))))
		b.WriteString("  ")
		b.WriteString(observeLevelBadge(str(e["level"])))
		b.WriteString("  ")
		b.WriteString(msg)
		b.WriteString("\n")
		for _, l := range lines[1:] {
			b.WriteString(strings.Repeat(" ", 17))
			b.WriteString(output.Dim(l))
			b.WriteString("\n")
		}
	}
	return b.String(), nil
}

func observeLogTime(ts string) string {
	if ts == "" {
		return strings.Repeat(" ", 8)
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return fmt.Sprintf("%-8s", "-")
	}
	return t.Format("15:04:05")
}

func observeLevelBadge(level string) string {
	l := strings.ToUpper(strings.TrimSpace(level))
	if l == "WARNING" {
		l = "WARN"
	}
	if l == "" {
		l = "LOG"
	}
	padded := fmt.Sprintf("%-5s", l)
	switch l {
	case "ERROR", "FATAL":
		return observeErrStyle.Render(padded)
	case "WARN":
		return observeWarnStyle.Render(padded)
	case "INFO":
		return observeInfoStyle.Render(padded)
	}
	return output.Dim(padded)
}

// observeWindowMinutes converts the --window duration into the whole minutes
// the errors endpoint expects (server clamps to 1..1440).
func observeWindowMinutes(s string) (int, error) {
	d, err := time.ParseDuration(s)
	if err != nil || d < time.Minute {
		return 0, fmt.Errorf("--window expects a duration of at least 1m (e.g. 15m, 1h, 6h, 24h), got %q", s)
	}
	return int(d.Minutes()), nil
}

func observeOr(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func observeFmt(m map[string]any, key string, format func(float64) string) string {
	if v, ok := m[key].(float64); ok {
		return format(v)
	}
	return "-"
}

func observePercent1Str(v float64) string { return fmt.Sprintf("%.1f%%", v) }
func observePercent2Str(v float64) string { return fmt.Sprintf("%.2f%%", v) }

func observeRateStr(v float64) string {
	if v >= 1000 {
		return fmt.Sprintf("%.1fk/s", v/1000)
	}
	return fmt.Sprintf("%.1f/s", v)
}

func observeLatencyStr(v float64) string {
	if v >= 1000 {
		return fmt.Sprintf("%.1fs", v/1000)
	}
	return fmt.Sprintf("%.0fms", v)
}

// observeUptime renders the overview's uptime field (the deployment's
// createdAt timestamp) as a compact age, matching the web UI.
func observeUptime(iso string) string {
	if iso == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return iso
	}
	d := time.Since(t)
	switch {
	case d < 0:
		return "0s"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

// observeSeriesLatest returns the newest non-null y of a {x,y} series.
func observeSeriesLatest(v any) (float64, bool) {
	pts, _ := v.([]any)
	for i := len(pts) - 1; i >= 0; i-- {
		if m, ok := pts[i].(map[string]any); ok {
			if y, ok := m["y"].(float64); ok {
				return y, true
			}
		}
	}
	return 0, false
}

func observeTruncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
