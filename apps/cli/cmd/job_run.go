package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

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
	return &cobra.Command{
		Use:   "get <runId>",
		Short: "Show a run: status, timing, and per-step results",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), jobRunPath(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
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
			return nil
		},
	}
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
	c := &cobra.Command{
		Use:   "logs <runId>",
		Short: "Print step logs (all steps in order, or one with --step)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
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
	return c
}
