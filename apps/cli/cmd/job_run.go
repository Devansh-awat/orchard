package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/exitcode"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func jobRunCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "job-run",
		GroupID: groupResources,
		Aliases: []string{"job-runs"},
		Short:   "Inspect and manage job runs",
	}
	c.AddCommand(
		jobRunGetCmd(),
		jobRunCancelCmd(),
		jobRunLogsCmd(),
	)
	return c
}

func jobRunPath(id string, rest ...string) string {
	p := "/job-runs/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func jobRunGetCmd() *cobra.Command {
	var watch bool
	c := &cobra.Command{
		Use:   "get <runId>",
		Short: "Show a run: status, timing, and per-step results",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if watch && !output.IsTTY() {
				return &exitcode.UsageError{Err: errors.New("--watch needs an interactive terminal")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), jobRunPath(args[0]), &raw); err != nil {
				return err
			}
			if !watch {
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				jobRunRenderKV(raw)
				return nil
			}
			fmt.Print(eventsClearScreen)
			jobRunRenderKV(raw)
			// run detail responses carry no organizationId, so there is no org
			// to subscribe to — pure polling instead of SSE + fallback.
			return eventsWatchPoll(cmd.Context(), 5*time.Second, func(ctx context.Context) error {
				var cur map[string]any
				if err := cl.GetJSON(ctx, jobRunPath(args[0]), &cur); err != nil {
					return err
				}
				fmt.Print(eventsClearScreen)
				jobRunRenderKV(cur)
				return nil
			})
		},
	}
	c.Flags().BoolVar(&watch, "watch", false, "keep re-rendering as the run progresses (TTY only)")
	return c
}

// jobRunRenderKV prints the table-mode detail view for one run.
func jobRunRenderKV(raw map[string]any) {
	pairs := [][2]string{
		{"id", pick(raw, "id")},
		{"job", pick(raw, "jobName", "jobId")},
		{"number", pick(raw, "number")},
		{"status", output.Status(pick(raw, "status"))},
		{"trigger", pick(raw, "trigger")},
	}
	if tb, ok := raw["triggeredBy"].(map[string]any); ok {
		pairs = append(pairs, [2]string{"triggered by", pick(tb, "name", "username")})
	}
	for _, opt := range [][2]string{
		{"started", pick(raw, "startedAt")},
		{"finished", pick(raw, "finishedAt")},
		{"duration", jobDuration(raw)},
		{"error", pick(raw, "errorMessage")},
	} {
		if opt[1] != "" {
			pairs = append(pairs, opt)
		}
	}
	for _, s := range asList(raw["steps"]) {
		val := fmt.Sprintf("%s %s", pick(s, "name"), output.Status(pick(s, "status")))
		if d := jobDuration(s); d != "" {
			val += " (" + d + ")"
		}
		if ec := pick(s, "exitCode"); ec != "" {
			val += " exit=" + ec
		}
		if r := pick(s, "reason"); r != "" {
			val += " " + output.Dim(r)
		}
		pairs = append(pairs, [2]string{"step " + pick(s, "stepOrder"), val})
	}
	output.KV(pairs)
}

// jobRunTerminal reports whether a run status means no more log output is
// coming (mirrors jobRunWaitSpec's terminal sets).
func jobRunTerminal(status string) bool {
	switch strings.ToLower(status) {
	case "succeeded", "failed", "canceled", "cancelled", "skipped", "timed_out":
		return true
	}
	return false
}

func jobRunCancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <runId>",
		Short: "Cancel an in-progress run (remaining steps are skipped)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("cancel job run %s (remaining steps are skipped)", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, jobRunPath(args[0], "cancel"), map[string]any{}, nil); err != nil {
				return err
			}
			output.Successf("cancelled job run %s", args[0])
			return nil
		},
	}
}

func jobRunPrintLogs(logs string) {
	fmt.Print(logs)
	if logs != "" && !strings.HasSuffix(logs, "\n") {
		fmt.Println()
	}
}

func jobRunLogsCmd() *cobra.Command {
	var step int
	var follow bool
	c := &cobra.Command{
		Use:   "logs <runId>",
		Short: "Print step logs (all steps in order, or one with --step)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if follow {
				return jobRunFollowLogs(cmd.Context(), cl, args[0], step)
			}
			if step > 0 {
				var raw map[string]any
				if err := cl.GetJSON(cmd.Context(), jobRunPath(args[0], "steps", strconv.Itoa(step), "logs"), &raw); err != nil {
					return err
				}
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				if b, _ := raw["live"].(bool); b {
					output.Warnf("step is still running (live tail)")
				}
				if b, _ := raw["truncated"].(bool); b {
					output.Warnf("logs were truncated")
				}
				jobRunPrintLogs(str(raw["logs"]))
				return nil
			}
			var run map[string]any
			if err := cl.GetJSON(cmd.Context(), jobRunPath(args[0]), &run); err != nil {
				return err
			}
			steps := asList(run["steps"])
			if len(steps) == 0 {
				output.Warnf("run %s has no steps", args[0])
				return nil
			}
			entries := []map[string]any{}
			for _, s := range steps {
				order := pick(s, "stepOrder")
				if order == "" {
					continue
				}
				var lr map[string]any
				if err := cl.GetJSON(cmd.Context(), jobRunPath(args[0], "steps", url.PathEscape(order), "logs"), &lr); err != nil {
					return err
				}
				entries = append(entries, map[string]any{
					"step":      s["stepOrder"],
					"name":      s["name"],
					"status":    s["status"],
					"logs":      lr["logs"],
					"truncated": lr["truncated"],
					"live":      lr["live"],
				})
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(entries)
			}
			for _, e := range entries {
				if len(entries) > 1 {
					fmt.Println(output.Dim(fmt.Sprintf("── step %s: %s (%s)", pick(e, "step"), pick(e, "name"), pick(e, "status"))))
				}
				if b, _ := e["truncated"].(bool); b {
					output.Warnf("step %s logs were truncated", pick(e, "step"))
				}
				jobRunPrintLogs(str(e["logs"]))
			}
			return nil
		},
	}
	c.Flags().IntVar(&step, "step", 0, "1-based step number (default: all steps in order)")
	c.Flags().BoolVarP(&follow, "follow", "f", false, "poll for new log lines while the run is active; stops once it finishes")
	return c
}

// jobRunFollowLogs polls the run every 2s, printing newly-appended log lines.
// Each cycle checks the run status; once it turns terminal the same (final)
// fetch is still printed and the loop stops by cancelling its own context.
func jobRunFollowLogs(ctx context.Context, cl *api.Client, runID string, step int) error {
	followCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	fetch := func(ctx context.Context) (string, error) {
		var run map[string]any
		if err := cl.GetJSON(ctx, jobRunPath(runID), &run); err != nil {
			return "", err
		}
		var b strings.Builder
		if step > 0 {
			var lr map[string]any
			if err := cl.GetJSON(ctx, jobRunPath(runID, "steps", strconv.Itoa(step), "logs"), &lr); err != nil {
				return "", err
			}
			b.WriteString(str(lr["logs"]))
		} else {
			steps := asList(run["steps"])
			for _, s := range steps {
				order := pick(s, "stepOrder")
				if order == "" {
					continue
				}
				switch strings.ToLower(pick(s, "status")) {
				case "", "pending", "queued":
					continue // not started: no logs to fetch yet
				}
				var lr map[string]any
				if err := cl.GetJSON(ctx, jobRunPath(runID, "steps", url.PathEscape(order), "logs"), &lr); err != nil {
					return "", err
				}
				if len(steps) > 1 {
					b.WriteString(output.Dim("── step "+order+": "+pick(s, "name")) + "\n")
				}
				logs := str(lr["logs"])
				b.WriteString(logs)
				if logs != "" && !strings.HasSuffix(logs, "\n") {
					b.WriteString("\n")
				}
			}
		}
		if jobRunTerminal(pick(run, "status")) {
			cancel()
		}
		return b.String(), nil
	}
	return followLines(followCtx, 2*time.Second, fetch, os.Stdout)
}
