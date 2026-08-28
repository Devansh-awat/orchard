package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func jobCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "job",
		GroupID: groupResources,
		Aliases: []string{"jobs"},
		Short:   "Manage scheduled jobs (multi-step pipelines)",
	}
	c.AddCommand(
		jobListCmd(),
		jobGetCmd(),
		jobCreateCmd(),
		jobUpdateCmd(),
		jobPauseCmd(),
		jobResumeCmd(),
		jobDeleteCmd(),
		jobStepsCmd(),
		jobTriggerCmd(),
		jobRunsCmd(),
	)
	return c
}

func jobPath(id string, rest ...string) string {
	p := "/jobs/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

// jobRunWaitSpec polls a run until it leaves the pending/running states.
func jobRunWaitSpec(runID string) api.WaitSpec {
	return api.WaitSpec{
		Path:    jobRunPath(runID),
		Field:   "status",
		Success: []string{"succeeded"},
		Failure: []string{"failed", "canceled", "skipped", "timed_out"},
	}
}

const jobStepsHelp = "The steps file is a JSON array of step objects (1-10 steps), for example:\n\n" +
	"  [\n" +
	"    {\"name\": \"refresh\", \"type\": \"script\", \"scriptRuntime\": \"bash\", \"script\": \"echo hi\"},\n" +
	"    {\"name\": \"prune\", \"type\": \"app\", \"deploymentId\": \"<uuid>\", \"command\": \"node prune.js\"},\n" +
	"    {\"name\": \"custom\", \"type\": \"image\", \"image\": \"alpine:3\", \"command\": \"echo done\"}\n" +
	"  ]\n\n" +
	"Step fields:\n" +
	"  name                display name (defaults to \"Step N\")\n" +
	"  type                script | app | image\n" +
	"  script              inline source (script type, required)\n" +
	"  scriptRuntime       bash | python | node (script type, required)\n" +
	"  deploymentId        deployment UUID from the same project (app type, required)\n" +
	"  image               container image reference (image type, required)\n" +
	"  command             shell command; required for app steps, optional for image steps\n" +
	"  envVars             [{\"key\": \"K\", \"value\": \"V\"}] (app steps override the deployment env)\n" +
	"  timeoutSeconds      30-21600 (default 1800)\n" +
	"  retries             0-3 (default 0)\n" +
	"  cpuRequestMilli     50-8000\n" +
	"  memoryRequestBytes  64Mi-16Gi as a byte count (number or string)"

// jobStepsFromFile reads a steps JSON file (a bare array or {"steps": [...]}).
func jobStepsFromFile(path string) ([]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var arr []any
	if err := json.Unmarshal(data, &arr); err == nil {
		return arr, nil
	}
	var wrapped struct {
		Steps []any `json:"steps"`
	}
	if err := json.Unmarshal(data, &wrapped); err == nil && wrapped.Steps != nil {
		return wrapped.Steps, nil
	}
	return nil, fmt.Errorf("%s: expected a JSON array of steps or {\"steps\": [...]}", path)
}

// jobDuration renders elapsed time from a startedAt/finishedAt pair (running
// entries count up to now).
func jobDuration(m map[string]any) string {
	started := pick(m, "startedAt")
	if started == "" {
		return ""
	}
	st, err := time.Parse(time.RFC3339Nano, started)
	if err != nil {
		return ""
	}
	end := time.Now()
	if f := pick(m, "finishedAt"); f != "" {
		if et, perr := time.Parse(time.RFC3339Nano, f); perr == nil {
			end = et
		}
	}
	d := end.Sub(st).Round(time.Second)
	if d < 0 {
		d = 0
	}
	return d.String()
}

func jobLastRun(j map[string]any) string {
	lr, ok := j["lastRun"].(map[string]any)
	if !ok {
		return ""
	}
	s := output.Status(pick(lr, "status"))
	if n := pick(lr, "number"); n != "" {
		s = "#" + n + " " + s
	}
	return s
}

func jobListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List jobs in the org (or the current project when one is set)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			var path string
			if scope := scopedProject(cfg); scope != "" {
				proj, rerr := resolveProject(cmd.Context(), cl, scope)
				if rerr != nil {
					return rerr
				}
				path = "/projects/" + url.PathEscape(str(proj["id"])) + "/jobs"
			} else {
				orgID, rerr := requireOrg(cmd.Context(), cl, cfg)
				if rerr != nil {
					return rerr
				}
				path = "/organizations/" + url.PathEscape(orgID) + "/jobs"
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, j := range asList(raw) {
				sched := pick(j, "scheduleCron")
				if sched == "" {
					sched = output.Dim("manual")
				}
				paused := ""
				if b, ok := j["enabled"].(bool); ok && !b {
					paused = "✓"
				}
				rows = append(rows, []string{
					pick(j, "id"),
					pick(j, "name"),
					sched,
					paused,
					jobLastRun(j),
					pick(j, "nextRunAt"),
				})
			}
			output.Table([]string{"id", "name", "schedule", "paused", "last run", "next run"}, rows)
			return nil
		},
	}
}

func jobGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a job and its steps",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), jobPath(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			sched := pick(raw, "scheduleCron")
			if sched == "" {
				sched = "manual"
			}
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"project", pick(raw, "projectName", "projectId")},
				{"schedule", sched},
				{"enabled", pick(raw, "enabled")},
				{"concurrency", pick(raw, "concurrencyPolicy")},
			}
			for _, opt := range [][2]string{
				{"description", pick(raw, "description")},
				{"timezone", pick(raw, "timeZone")},
				{"run timeout (s)", pick(raw, "runTimeoutSeconds")},
				{"last run", jobLastRun(raw)},
				{"next run", pick(raw, "nextRunAt")},
				{"created", pick(raw, "createdAt")},
			} {
				if opt[1] != "" {
					pairs = append(pairs, opt)
				}
			}
			for _, s := range asList(raw["steps"]) {
				val := fmt.Sprintf("%s (%s)", pick(s, "name"), pick(s, "type"))
				if d := pick(s, "scriptRuntime"); d != "" {
					val += " " + d
				}
				if img := pick(s, "image", "resolvedImage"); img != "" {
					val += " " + img
				}
				if c := pick(s, "command"); c != "" {
					val += " " + output.Dim(c)
				}
				pairs = append(pairs, [2]string{"step " + pick(s, "stepOrder"), val})
			}
			output.KV(pairs)
			return nil
		},
	}
}

func jobCreateCmd() *cobra.Command {
	var name, cron, description, timezone, concurrency, stepsFile string
	var paused bool
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a job in the project from a steps file",
		Long: "Create a job: an ordered pipeline of steps that runs on a cron schedule\n" +
			"and/or on demand. The cron is 5-field and interpreted in UTC unless\n" +
			"--timezone is set; omit --cron for a manual-only job.\n\n" + jobStepsHelp,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			steps, err := jobStepsFromFile(stepsFile)
			if err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"name": name, "steps": steps}
			if cron != "" {
				body["scheduleCron"] = cron
			}
			if description != "" {
				body["description"] = description
			}
			if timezone != "" {
				body["timeZone"] = timezone
			}
			if concurrency != "" {
				body["concurrencyPolicy"] = concurrency
			}
			if paused {
				body["enabled"] = false
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/"+url.PathEscape(projectID)+"/jobs", body, &raw); err != nil {
				return err
			}
			output.Successf("created job %s (%s)", name, str(raw["id"]))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "job name, unique within the project (required)")
	c.Flags().StringVar(&cron, "cron", "", "5-field cron schedule (omit for manual-only)")
	c.Flags().StringVar(&description, "description", "", "optional description")
	c.Flags().StringVar(&timezone, "timezone", "", "IANA time zone for the schedule (default UTC)")
	c.Flags().StringVar(&concurrency, "concurrency", "", "concurrency policy: forbid|allow (server default forbid)")
	c.Flags().BoolVar(&paused, "paused", false, "create the job with a paused schedule")
	c.Flags().StringVar(&stepsFile, "steps", "", "path to the steps JSON file (required)")
	_ = c.MarkFlagRequired("name")
	_ = c.MarkFlagRequired("steps")
	return c
}

func jobUpdateCmd() *cobra.Command {
	var name, cron, description, concurrency string
	var paused bool
	c := &cobra.Command{
		Use:   "update <id>",
		Short: "Update a job's name, schedule, or paused state",
		Long: "Update a job. Only the flags you pass change; pass --cron \"\" to make\n" +
			"the job manual-only. To change steps, use `orchard job steps set`.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			if cmd.Flags().Changed("cron") {
				if cron == "" {
					body["scheduleCron"] = nil
				} else {
					body["scheduleCron"] = cron
				}
			}
			if cmd.Flags().Changed("description") {
				body["description"] = description
			}
			if cmd.Flags().Changed("concurrency") {
				body["concurrencyPolicy"] = concurrency
			}
			if cmd.Flags().Changed("paused") {
				body["enabled"] = !paused
			}
			if len(body) == 0 {
				return errors.New("nothing to update: pass --name, --cron, --description, --concurrency or --paused")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, jobPath(args[0]), body, &raw); err != nil {
				return err
			}
			output.Successf("updated job %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "new job name")
	c.Flags().StringVar(&cron, "cron", "", `new 5-field cron ("" for manual-only)`)
	c.Flags().StringVar(&description, "description", "", "new description")
	c.Flags().StringVar(&concurrency, "concurrency", "", "concurrency policy: forbid|allow")
	c.Flags().BoolVar(&paused, "paused", false, "pause (true) or resume (false) the schedule")
	return c
}

func jobSetEnabled(cmd *cobra.Command, id string, enabled bool, did string) error {
	cl, _, err := client()
	if err != nil {
		return err
	}
	if err := cl.Send(cmd.Context(), http.MethodPatch, jobPath(id), map[string]any{"enabled": enabled}, nil); err != nil {
		return err
	}
	output.Successf("%s job %s", did, id)
	return nil
}

func jobPauseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "pause <id>",
		Short: "Pause a job's schedule (manual runs still work)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return jobSetEnabled(cmd, args[0], false, "paused")
		},
	}
}

func jobResumeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "resume <id>",
		Short: "Resume a paused job's schedule",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return jobSetEnabled(cmd, args[0], true, "resumed")
		},
	}
}

func jobDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a job, its schedule, and its run history",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("permanently delete job %s and its entire run history", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, jobPath(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted job %s", args[0])
			return nil
		},
	}
}

func jobStepsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "steps",
		Short: "Manage a job's step pipeline",
	}
	c.AddCommand(jobStepsSetCmd())
	return c
}

func jobStepsSetCmd() *cobra.Command {
	var file string
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Replace a job's entire ordered step list",
		Long: "Replace all steps. Running runs keep their snapshot; future runs use\n" +
			"the new steps.\n\n" + jobStepsHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			steps, err := jobStepsFromFile(file)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPut, jobPath(args[0], "steps"), map[string]any{"steps": steps}, &raw); err != nil {
				return err
			}
			output.Successf("replaced steps of job %s (%d step(s))", args[0], len(steps))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&file, "file", "", "path to the steps JSON file (required)")
	_ = c.MarkFlagRequired("file")
	return c
}

func jobTriggerCmd() *cobra.Command {
	var allowConcurrent bool
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "run <id>",
		Short: "Trigger a job run now",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"allowConcurrent": allowConcurrent}
			var run map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, jobPath(args[0], "runs"), body, &run); err != nil {
				return err
			}
			runID := str(run["id"])
			output.Successf("started run #%s of job %s (%s)", pick(run, "number"), args[0], runID)
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(run); err != nil {
					return err
				}
			}
			if *wait && runID != "" {
				return runWait(cmd.Context(), cl, jobRunWaitSpec(runID), *timeout)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&allowConcurrent, "allow-concurrent", false, "start even if another run is active")
	wait, timeout = addWaitFlags(c)
	return c
}

// jobFetchRuns pages GET /jobs/:id/runs locally: the envelope is
// {"runs": [...], "nextCursor": ...}, which fetchPaged's asList cannot unwrap.
func jobFetchRuns(ctx context.Context, cl *api.Client, jobID string, limit int, cursor string, all bool) ([]map[string]any, string, error) {
	items := []map[string]any{}
	for page := 0; ; page++ {
		if page >= maxPages {
			return items, cursor, errors.New("--all hit the 100-page safety cap")
		}
		q := url.Values{}
		if limit > 0 {
			q.Set("limit", strconv.Itoa(limit))
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		p := jobPath(jobID, "runs")
		if len(q) > 0 {
			p += "?" + q.Encode()
		}
		var raw map[string]any
		if err := cl.GetJSON(ctx, p, &raw); err != nil {
			return items, cursor, err
		}
		items = append(items, asList(raw["runs"])...)
		cursor = pick(raw, "nextCursor")
		if cursor == "" || !all {
			return items, cursor, nil
		}
	}
}

func jobRunsCmd() *cobra.Command {
	var limit *int
	var cursor *string
	var all *bool
	c := &cobra.Command{
		Use:   "runs <id>",
		Short: "List a job's run history, newest first",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			runs, next, err := jobFetchRuns(cmd.Context(), cl, args[0], *limit, *cursor, *all)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				out := map[string]any{"runs": runs}
				if next != "" {
					out["nextCursor"] = next
				}
				return output.JSON(out)
			}
			rows := [][]string{}
			for _, r := range runs {
				rows = append(rows, []string{
					pick(r, "id"),
					pick(r, "number"),
					output.Status(pick(r, "status")),
					pick(r, "trigger"),
					pick(r, "startedAt", "createdAt"),
					jobDuration(r),
				})
			}
			output.Table([]string{"id", "#", "status", "trigger", "started", "duration"}, rows)
			if next != "" {
				output.Warnf("more runs available: resume with --cursor %s", next)
			}
			return nil
		},
	}
	limit, cursor, all = addPageFlags(c)
	return c
}
