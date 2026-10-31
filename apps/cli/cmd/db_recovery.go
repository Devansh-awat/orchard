package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var dbOperationMinInterval = 2 * time.Second

type dbOperationError struct {
	op map[string]any
}

func (e *dbOperationError) Error() string {
	kind := pick(e.op, "kind")
	if kind == "" {
		kind = "operation"
	}
	if msg := pick(e.op, "error"); msg != "" {
		return fmt.Sprintf("%s %s failed: %s", kind, pick(e.op, "id"), msg)
	}
	return fmt.Sprintf("%s %s failed", kind, pick(e.op, "id"))
}

func dbOperationPath(id string) string {
	return "/database-operations/" + url.PathEscape(id)
}

func dbWaitOperation(ctx context.Context, cl *api.Client, id string, timeout time.Duration) (map[string]any, error) {
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var sp *output.Spinner
	if output.StderrIsTTY() && fmtFlag() != output.FormatJSON {
		sp = output.NewSpinner("waiting for operation " + id)
	}
	stop := func() {
		if sp != nil {
			sp.Stop()
			sp = nil
		}
	}
	defer stop()
	var op map[string]any
	last := ""
	for {
		started := time.Now()
		var cur map[string]any
		err := cl.GetJSON(wctx, dbOperationPath(id)+"?wait=1", &cur)
		if err != nil {
			if ctx.Err() == nil && wctx.Err() != nil {
				stop()
				return op, fmt.Errorf("operation %s still %s after %s: %w", id, dbOperationLabel(op), timeout, api.ErrWaitTimeout)
			}
			return op, err
		}
		op = cur
		if label := dbOperationLabel(op); label != "" && label != last {
			last = label
			msg := "phase: " + label
			if progress := dbOperationProgress(op); progress != "" {
				msg += " (" + progress + ")"
			}
			if sp != nil {
				sp.Update(msg)
			} else {
				output.Warnf("%s", msg)
			}
		}
		switch strings.ToLower(pick(op, "status")) {
		case "succeeded":
			stop()
			output.Successf("%s %s succeeded", dbOr(pick(op, "kind"), "operation"), id)
			return op, nil
		case "failed", "cancelled", "canceled":
			stop()
			return op, &dbOperationError{op: op}
		}
		if wait := dbOperationMinInterval - time.Since(started); wait > 0 {
			select {
			case <-time.After(wait):
			case <-wctx.Done():
			}
		}
	}
}

func dbOperationLabel(op map[string]any) string {
	if op == nil {
		return "pending"
	}
	if phase := pick(op, "phase"); phase != "" {
		return phase
	}
	return pick(op, "status")
}

func dbOperationProgress(op map[string]any) string {
	res, _ := op["result"].(map[string]any)
	return pick(res, "progress")
}

func dbOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func dbFinishOperation(ctx context.Context, cl *api.Client, op map[string]any, label string, wait bool, timeout time.Duration) error {
	id := str(op["id"])
	output.Successf("%s started: operation %s", label, id)
	if !wait || id == "" {
		if fmtFlag() == output.FormatJSON {
			return output.JSON(op)
		}
		dbRenderOperation(op)
		if id != "" {
			output.Warnf("follow it with `orchard db ops get %s --wait`", id)
		}
		return nil
	}
	final, err := dbWaitOperation(ctx, cl, id, timeout)
	if final == nil {
		final = op
	}
	if fmtFlag() == output.FormatJSON {
		if jerr := output.JSON(final); jerr != nil {
			return jerr
		}
		return err
	}
	dbRenderOperation(final)
	return err
}

func dbRenderOperation(op map[string]any) {
	pairs := [][2]string{
		{"id", pick(op, "id")},
		{"kind", pick(op, "kind")},
		{"mode", pick(op, "mode")},
		{"status", output.Status(pick(op, "status"))},
		{"phase", pick(op, "phase")},
		{"database", pick(op, "databaseId")},
		{"new database", pick(op, "targetDatabaseId")},
		{"target", dbDescribeTarget(op["target"])},
		{"created", pick(op, "createdAt")},
		{"started", pick(op, "startedAt")},
		{"finished", pick(op, "finishedAt")},
		{"error", pick(op, "error")},
	}
	if res, ok := op["result"].(map[string]any); ok {
		pairs = append(pairs,
			[2]string{"progress", pick(res, "progress")},
			[2]string{"recovered from", dbDescribeTarget(res["recoveredFrom"])},
			[2]string{"recovered at", pick(res, "recoveredAt")},
			[2]string{"recovery time", dbMillis(res["recoveryMs"])},
			[2]string{"size", dbHumanSize(res["sizeBytes"])},
		)
		if r, ok := res["rehearsal"].(map[string]any); ok {
			line := "done"
			if d := dbMillis(r["upgradeMs"]); d != "" {
				line = "pg_upgrade took " + d + " on the copy, about the expected downtime"
			}
			pairs = append(pairs, [2]string{"rehearsal", line})
		}
		if v, ok := res["verdict"].(map[string]any); ok {
			pairs = append(pairs, [2]string{"check", dbVerdictLine(v)})
		}
		if r, ok := res["retired"].(map[string]any); ok {
			if b, _ := r["deleted"].(bool); b {
				pairs = append(pairs, [2]string{"previous copy", "deleted"})
			} else if until := pick(r, "retireAfter"); until != "" {
				pairs = append(pairs, [2]string{"previous copy", "kept until " + until + " (undo with `orchard db ops undo " + pick(op, "id") + "`)"})
			}
		}
	}
	output.KV(dbTrimEmpty(pairs))
}

func dbVerdictLine(v map[string]any) string {
	passed, _ := v["passed"].(bool)
	line := "failed"
	if passed {
		line = "passed"
	}
	if n := pick(v, "tablesChecked"); n != "" {
		line += ", " + n + " tables checked"
	}
	if reasons := dbStrings(v["reasons"]); len(reasons) > 0 {
		line += ": " + strings.Join(reasons, "; ")
	}
	return line
}

func dbDescribeTarget(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		switch pick(t, "type") {
		case "checkpoint":
			return "checkpoint " + pick(t, "checkpointId")
		case "backup":
			return "backup " + pick(t, "backupId")
		case "time":
			return "time " + pick(t, "time")
		case "major":
			return "postgres " + pick(t, "major")
		case "":
			b, _ := json.Marshal(t)
			return string(b)
		default:
			return pick(t, "type")
		}
	}
	return ""
}

func dbMillis(v any) string {
	f, ok := v.(float64)
	if !ok || f <= 0 {
		return ""
	}
	return (time.Duration(f) * time.Millisecond).Round(100 * time.Millisecond).String()
}

func dbStrings(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, e := range list {
		switch t := e.(type) {
		case string:
			out = append(out, t)
		case map[string]any:
			b, _ := json.Marshal(t)
			out = append(out, string(b))
		default:
			out = append(out, fmt.Sprint(t))
		}
	}
	return out
}

func dbTargetEnvForDatabase(ctx context.Context, cl *api.Client, dbID string) (string, error) {
	if envFlag == "" {
		return "", nil
	}
	db, err := dbFetch(ctx, cl, dbID)
	if err != nil {
		return "", err
	}
	return dbEnvInProject(ctx, cl, str(db["projectId"]), envFlag)
}

func dbTargetEnvInScope(ctx context.Context, cl *api.Client, cfg *config.Config) (string, error) {
	if envFlag == "" {
		return "", nil
	}
	v := scopedProject(cfg)
	if v == "" {
		return envFlag, nil
	}
	p, err := resolveProject(ctx, cl, v)
	if err != nil {
		return "", err
	}
	return dbEnvInProject(ctx, cl, str(p["id"]), envFlag)
}

func dbEnvInProject(ctx context.Context, cl *api.Client, projectID, v string) (string, error) {
	if projectID == "" {
		return v, nil
	}
	e, err := resolveEnv(ctx, cl, projectID, v)
	if err != nil {
		return "", err
	}
	return str(e["id"]), nil
}

func dbAtLabel(at string) string {
	switch at {
	case "latest":
		return "the latest recoverable point"
	case "now":
		return "the live database"
	}
	return "the state at " + at
}

func dbForkCmd() *cobra.Command {
	var (
		name, at, checkpoint, backup string
		wait                         *bool
		timeout                      *time.Duration
	)
	c := &cobra.Command{
		Use:   "fork <id>",
		Short: "Copy a database into a new one, from now, a backup, a checkpoint or a point in time",
		Long: `Create a new database from an existing one. The original is not touched.

By default the copy is taken from the live database (--at now). --at latest uses the
latest recoverable point from backups, --at <ISO time> picks a point in time, and
--checkpoint or --backup start from that exact restore point.

--name names the new database and --env puts it in another environment of the same project.
The new database shows status restoring until it is ready.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if dbCountSet(at != "", checkpoint != "", backup != "") > 1 {
				return &exitcode.UsageError{Err: errors.New("pick one of --at, --checkpoint or --backup")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if at != "" {
				body["at"] = at
			}
			if checkpoint != "" {
				body["checkpointId"] = checkpoint
			}
			if backup != "" {
				body["backupId"] = backup
			}
			if name != "" {
				body["name"] = name
			}
			envID, err := dbTargetEnvForDatabase(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if envID != "" {
				body["environmentId"] = envID
			}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/fork", body, &op); err != nil {
				return err
			}
			return dbFinishOperation(cmd.Context(), cl, op, "fork", *wait, *timeout)
		},
	}
	c.Flags().StringVar(&name, "name", "", "name for the new database (server picks one by default)")
	c.Flags().StringVar(&at, "at", "", `where to copy from: "now" (default), "latest", or an ISO time`)
	c.Flags().StringVar(&checkpoint, "checkpoint", "", "start from this checkpoint id")
	c.Flags().StringVar(&backup, "backup", "", "start from this backup id")
	wait, timeout = addWaitFlags(c)
	return c
}

func dbCountSet(flags ...bool) int {
	n := 0
	for _, f := range flags {
		if f {
			n++
		}
	}
	return n
}

func dbOpsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "ops",
		Aliases: []string{"op", "operations"},
		Short:   "Inspect and control restore, fork, undelete, upgrade and restore test operations",
	}
	c.AddCommand(dbOpsListCmd(), dbOpsGetCmd(), dbOpsCancelCmd(), dbOpsUndoCmd())
	return c
}

func dbRenderOperations(raw any) {
	rows := [][]string{}
	for _, op := range asList(raw) {
		rows = append(rows, []string{
			pick(op, "id"),
			pick(op, "kind"),
			pick(op, "mode"),
			output.Status(pick(op, "status")),
			pick(op, "phase"),
			pick(op, "createdAt"),
			pick(op, "finishedAt"),
		})
	}
	output.Table([]string{"id", "kind", "mode", "status", "phase", "created", "finished"}, rows)
}

func dbOpsListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <dbId>",
		Aliases: []string{"ls"},
		Short:   "List operations on a database, newest first",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/operations", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderOperations(raw)
			return nil
		},
	}
}

func dbOpsGetCmd() *cobra.Command {
	var (
		wait    *bool
		timeout *time.Duration
	)
	c := &cobra.Command{
		Use:   "get <opId>",
		Short: "Show an operation (--wait blocks until it succeeds or fails)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if *wait {
				op, werr := dbWaitOperation(cmd.Context(), cl, args[0], *timeout)
				if op == nil {
					return werr
				}
				if fmtFlag() == output.FormatJSON {
					if jerr := output.JSON(op); jerr != nil {
						return jerr
					}
					return werr
				}
				dbRenderOperation(op)
				return werr
			}
			var op map[string]any
			if err := cl.GetJSON(cmd.Context(), dbOperationPath(args[0]), &op); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(op)
			}
			dbRenderOperation(op)
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func dbOpsCancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <opId>",
		Short: "Cancel an operation that has not finished",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, dbOperationPath(args[0])+"/cancel", map[string]any{}, &op); err != nil {
				return err
			}
			output.Successf("cancelled operation %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(op)
			}
			dbRenderOperation(op)
			return nil
		},
	}
}

func dbOpsUndoCmd() *cobra.Command {
	var (
		wait    *bool
		timeout *time.Duration
	)
	c := &cobra.Command{
		Use:   "undo <opId>",
		Short: "Swap back to the copy from before an in-place restore (within 24 hours)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("undo restore %s: the database goes back to the copy from before it, and data written since the restore is replaced", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, dbOperationPath(args[0])+"/undo", map[string]any{}, &op); err != nil {
				return err
			}
			return dbFinishOperation(cmd.Context(), cl, op, "undo", *wait, *timeout)
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func dbCheckpointCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "checkpoint",
		Aliases: []string{"checkpoints", "cp"},
		Short:   "Manage checkpoints (named restore points you can roll back to)",
		Long: `A checkpoint marks a point in the database's history. It is restorable once its WAL
is archived (status durable) and is kept for 30 days.

Orchard also takes checkpoints on its own: before each deploy (pre_deploy), before an
in-place restore (pre_op), and before any DROP TABLE, DROP SCHEMA or DROP COLUMN when
DDL checkpoints are on (ddl).`,
	}
	c.AddCommand(
		dbCheckpointCreateCmd(),
		dbCheckpointListCmd(),
		dbCheckpointGroupCmd(),
		dbCheckpointRestoreCmd(),
		dbCheckpointRestoreGroupCmd(),
		dbCheckpointRemoveCmd(),
	)
	return c
}

func dbRenderCheckpoints(list []map[string]any, withDatabase bool) {
	headers := []string{"id", "label", "kind", "status", "created", "expires"}
	if withDatabase {
		headers = append([]string{"database"}, headers...)
	}
	rows := [][]string{}
	for _, cp := range list {
		label := pick(cp, "label")
		if label == "" {
			label = pick(cp, "detail")
		}
		row := []string{
			pick(cp, "id"),
			label,
			pick(cp, "kind"),
			output.Status(pick(cp, "status")),
			pick(cp, "createdAt"),
			pick(cp, "expiresAt"),
		}
		if withDatabase {
			row = append([]string{pick(cp, "databaseId")}, row...)
		}
		rows = append(rows, row)
	}
	output.Table(headers, rows)
}

func dbCheckpointCreateCmd() *cobra.Command {
	var label string
	c := &cobra.Command{
		Use:   "create [dbId]",
		Short: "Take a checkpoint of one database, or of every database in the project or environment",
		Long: `With a database id, checkpoints that database. Without one, checkpoints every
database in the scoped project (--project), narrowed to one environment with --env.
All checkpoints in one call share a group id, so ` + "`orchard db checkpoint restore-group`" + `
can roll them back together.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if label != "" {
				body["label"] = label
			}
			if len(args) == 1 {
				var cp map[string]any
				if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/checkpoints", body, &cp); err != nil {
					return err
				}
				output.Successf("checkpoint %s created (%s)", pick(cp, "id"), dbOr(pick(cp, "status"), "pending"))
				if fmtFlag() == output.FormatJSON {
					return output.JSON(cp)
				}
				dbRenderCheckpoints([]map[string]any{cp}, false)
				return nil
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body["projectId"] = projectID
			if v := scopedEnv(cfg); v != "" {
				envID, eerr := dbEnvInProject(cmd.Context(), cl, projectID, v)
				if eerr != nil {
					return eerr
				}
				body["environmentId"] = envID
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/checkpoints", body, &raw); err != nil {
				return err
			}
			list := asList(raw["checkpoints"])
			output.Successf("created %d checkpoint(s) in group %s", len(list), pick(raw, "groupId"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderCheckpoints(list, true)
			return nil
		},
	}
	c.Flags().StringVar(&label, "label", "", "label to find the checkpoint by later")
	return c
}

func dbCheckpointListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <dbId>",
		Aliases: []string{"ls"},
		Short:   "List a database's checkpoints",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/checkpoints", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderCheckpoints(asList(raw), false)
			return nil
		},
	}
}

func dbCheckpointGroupCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "group <groupId>",
		Short: "List the checkpoints taken together in one group",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/checkpoints/groups/"+url.PathEscape(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderCheckpoints(asList(raw), true)
			return nil
		},
	}
}

func dbCheckpointRestoreCmd() *cobra.Command {
	var (
		fork    bool
		name    string
		wait    *bool
		timeout *time.Duration
	)
	c := &cobra.Command{
		Use:   "restore <checkpointId>",
		Short: "Restore a database to a checkpoint (in place, or into a new database with --fork)",
		Long: `In place (the default) replaces the database's current data with its state at the
checkpoint. The previous copy is kept stopped for 24 hours, so ` + "`orchard db ops undo <operationId>`" + `
can swap it back.

--fork restores into a new database instead. --name and --env pick its name and environment.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !fork && (name != "" || envFlag != "") {
				return &exitcode.UsageError{Err: errors.New("--name and --env only apply with --fork")}
			}
			if !fork {
				if err := output.Confirm(fmt.Sprintf("restore the database of checkpoint %s in place: this REPLACES all current data (the previous copy is kept stopped for 24 hours)", args[0]), yesFlag); err != nil {
					return err
				}
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"mode": "in_place"}
			if fork {
				body["mode"] = "fork"
				if name != "" {
					body["name"] = name
				}
				envID, eerr := dbTargetEnvInScope(cmd.Context(), cl, cfg)
				if eerr != nil {
					return eerr
				}
				if envID != "" {
					body["environmentId"] = envID
				}
			}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/checkpoints/"+url.PathEscape(args[0])+"/restore", body, &op); err != nil {
				return err
			}
			return dbFinishOperation(cmd.Context(), cl, op, "restore", *wait, *timeout)
		},
	}
	c.Flags().BoolVar(&fork, "fork", false, "restore into a new database and leave the original untouched")
	c.Flags().StringVar(&name, "name", "", "name for the new database (with --fork)")
	wait, timeout = addWaitFlags(c)
	return c
}

func dbCheckpointRestoreGroupCmd() *cobra.Command {
	var (
		fork    bool
		wait    *bool
		timeout *time.Duration
	)
	c := &cobra.Command{
		Use:   "restore-group <groupId>",
		Short: "Restore every database in a checkpoint group to that group's checkpoints",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !fork {
				if err := output.Confirm(fmt.Sprintf("restore every database in checkpoint group %s in place: this REPLACES their current data (previous copies are kept stopped for 24 hours)", args[0]), yesFlag); err != nil {
					return err
				}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"mode": "in_place"}
			if fork {
				body["mode"] = "fork"
			}
			var raw any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/checkpoints/groups/"+url.PathEscape(args[0])+"/restore", body, &raw); err != nil {
				return err
			}
			ops := asList(raw)
			output.Successf("started %d restore(s) from group %s", len(ops), args[0])
			if !*wait {
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				dbRenderOperations(raw)
				return nil
			}
			deadline := time.Now().Add(*timeout)
			finals := make([]map[string]any, 0, len(ops))
			var firstErr error
			for _, op := range ops {
				remaining := time.Until(deadline)
				if remaining <= 0 {
					remaining = time.Millisecond
				}
				final, werr := dbWaitOperation(cmd.Context(), cl, str(op["id"]), remaining)
				if final == nil {
					final = op
				}
				finals = append(finals, final)
				if werr != nil {
					if firstErr == nil {
						firstErr = werr
					}
					if !errors.As(werr, new(*dbOperationError)) {
						break
					}
				}
			}
			if fmtFlag() == output.FormatJSON {
				if jerr := output.JSON(finals); jerr != nil {
					return jerr
				}
				return firstErr
			}
			list := make([]any, len(finals))
			for i, f := range finals {
				list[i] = f
			}
			dbRenderOperations(list)
			return firstErr
		},
	}
	c.Flags().BoolVar(&fork, "fork", false, "restore each into a new database and leave the originals untouched")
	wait, timeout = addWaitFlags(c)
	return c
}

func dbCheckpointRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "rm <checkpointId>",
		Aliases: []string{"delete"},
		Short:   "Hide a checkpoint so it is no longer offered for restore",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("remove checkpoint %s", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/checkpoints/"+url.PathEscape(args[0]), nil, &raw); err != nil {
				return err
			}
			output.Successf("removed checkpoint %s", args[0])
			if fmtFlag() == output.FormatJSON && raw != nil {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func dbTestBackupCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "test-backup",
		Aliases: []string{"restore-test", "restore-tests"},
		Short:   "Prove backups restore: restore the latest one into a throwaway copy and check it",
	}
	c.AddCommand(dbTestBackupRunCmd(), dbTestBackupListCmd())
	return c
}

func dbTestBackupRunCmd() *cobra.Command {
	var (
		wait    *bool
		timeout *time.Duration
	)
	c := &cobra.Command{
		Use:   "run <dbId>",
		Short: "Start a restore test now (the throwaway copy is deleted afterwards)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/restore-tests", map[string]any{}, &op); err != nil {
				return err
			}
			return dbFinishOperation(cmd.Context(), cl, op, "restore test", *wait, *timeout)
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func dbTestBackupListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <dbId>",
		Aliases: []string{"ls"},
		Short:   "List past restore tests and their results",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/restore-tests", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, op := range asList(raw) {
				res, _ := op["result"].(map[string]any)
				check := ""
				if v, ok := res["verdict"].(map[string]any); ok {
					check = dbVerdictLine(v)
				} else if e := pick(op, "error"); e != "" {
					check = e
				}
				rows = append(rows, []string{
					pick(op, "id"),
					output.Status(pick(op, "status")),
					pick(op, "phase"),
					dbMillis(res["recoveryMs"]),
					check,
					pick(op, "createdAt"),
				})
			}
			output.Table([]string{"id", "status", "phase", "recovery", "check", "created"}, rows)
			return nil
		},
	}
}

func dbTrashCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "trash",
		Short: "List and bring back deleted databases (kept for 30 days)",
	}
	c.AddCommand(dbTrashListCmd(), dbTrashRestoreCmd())
	return c
}

func dbTrashListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List deleted databases in the current project",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(projectID)+"/deleted-databases", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, d := range asList(raw) {
				recoverable := pick(d, "recoverableUntil")
				if recoverable == "" {
					recoverable = "not recoverable (no completed backup)"
				}
				rows = append(rows, []string{
					pick(d, "id"),
					pick(d, "name"),
					pick(d, "deletedAt"),
					pick(d, "deletedBy"),
					recoverable,
				})
			}
			output.Table([]string{"id", "name", "deleted", "by", "recoverable until"}, rows)
			return nil
		},
	}
}

func dbTrashRestoreCmd() *cobra.Command {
	var (
		name    string
		wait    *bool
		timeout *time.Duration
	)
	c := &cobra.Command{
		Use:   "restore <deletedId>",
		Short: "Bring a deleted database back from its backups",
		Long: `Recreate a deleted database from its last backups. --name gives it a new name and
--env puts it in another environment of its project.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if name != "" {
				body["name"] = name
			}
			envID, err := dbTargetEnvInScope(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if envID != "" {
				body["environmentId"] = envID
			}
			var op map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/deleted-databases/"+url.PathEscape(args[0])+"/restore", body, &op); err != nil {
				return err
			}
			return dbFinishOperation(cmd.Context(), cl, op, "undelete", *wait, *timeout)
		},
	}
	c.Flags().StringVar(&name, "name", "", "name for the restored database (default: its old name)")
	wait, timeout = addWaitFlags(c)
	return c
}

func dbRecoveryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "recovery <dbId>",
		Short: "Show how far back a database can be restored, and what it can be restored from",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/recovery", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			archiving := "not configured"
			if a, ok := raw["archiving"].(map[string]any); ok {
				if b, _ := a["ok"].(bool); b {
					archiving = "ok"
				} else {
					archiving = dbOr(pick(a, "message"), "failing")
				}
			}
			pairs := [][2]string{
				{"earliest", dbOr(pick(raw, "earliest"), "(nothing restorable)")},
				{"latest", pick(raw, "latest")},
				{"wal archiving", archiving},
				{"backups", strconv.Itoa(len(asList(raw["backups"])))},
				{"checkpoints", strconv.Itoa(len(asList(raw["checkpoints"])))},
			}
			if t, ok := raw["lastRestoreTest"].(map[string]any); ok {
				pairs = append(pairs, [2]string{"last restore test", dbRestoreTestLine(t)})
			}
			if p, ok := raw["protection"].(map[string]any); ok {
				pairs = append(pairs, [2]string{"protection", dbProtectionLine(p)})
			}
			output.KV(dbTrimEmpty(pairs))
			if active := asList(raw["activeOperations"]); len(active) > 0 {
				fmt.Println()
				dbRenderOperations(raw["activeOperations"])
			}
			return nil
		},
	}
}

func dbRestoreTestLine(t map[string]any) string {
	parts := []string{dbOr(pick(t, "status"), "unknown")}
	if at := pick(t, "finishedAt", "at", "createdAt"); at != "" {
		parts = append(parts, at)
	}
	ms := t["recoveryMs"]
	if res, ok := t["result"].(map[string]any); ok && ms == nil {
		ms = res["recoveryMs"]
	}
	if d := dbMillis(ms); d != "" {
		parts = append(parts, "recovered in "+d)
	}
	if e := pick(t, "error"); e != "" {
		parts = append(parts, e)
	}
	return strings.Join(parts, ", ")
}

func dbProtectionLine(p map[string]any) string {
	onOff := func(k string) string {
		if b, _ := p[k].(bool); b {
			return "on"
		}
		return "off"
	}
	return "deletion " + onOff("deletionProtection") + ", ddl checkpoints " + onOff("ddlCheckpoints") + ", restore tests " + onOff("restoreTests")
}
