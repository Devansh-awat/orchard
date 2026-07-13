package cmd

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func dbBackupCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "backup",
		Aliases: []string{"backups"},
		Short:   "Manage database backups",
	}
	c.AddCommand(dbBackupListCmd(), dbBackupCreateCmd(), dbBackupRestoreCmd())
	return c
}

func dbBackupListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <id>",
		Aliases: []string{"ls"},
		Short:   "List backups for a database",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/backups", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, b := range asList(raw) {
				rows = append(rows, []string{
					pick(b, "id"),
					pick(b, "label", "backupName"),
					pick(b, "type"),
					output.Status(pick(b, "status")),
					dbHumanSize(b["sizeBytes"]),
					pick(b, "createdAt"),
				})
			}
			output.Table([]string{"id", "label", "type", "status", "size", "created"}, rows)
			return nil
		},
	}
}

func dbBackupCreateCmd() *cobra.Command {
	var (
		label, kind string
		wait        *bool
		timeout     *time.Duration
	)
	c := &cobra.Command{
		Use:   "create <id>",
		Short: "Trigger a new backup (runs asynchronously)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if label != "" {
				body["label"] = label
			}
			if kind != "" {
				body["type"] = kind
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/backups", body, &raw); err != nil {
				return err
			}
			id := str(raw["id"])
			output.Successf("backup %s started", id)
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			}
			if *wait && id != "" {
				return dbWaitBackup(cmd.Context(), cl, args[0], id, *timeout)
			}
			return nil
		},
	}
	c.Flags().StringVar(&label, "label", "", "human-readable label for the backup")
	c.Flags().StringVar(&kind, "type", "", "backup type: full|diff|incr (default full)")
	wait, timeout = addWaitFlags(c)
	return c
}

func dbBackupRestoreCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restore <id> [backupId]",
		Short: "Restore from a backup (latest when backupId is omitted)",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			from := "the latest backup"
			body := map[string]any{}
			if len(args) == 2 {
				from = "backup " + args[1]
				body["backupId"] = args[1]
			}
			if err := output.Confirm(fmt.Sprintf("restore database %s from %s — this REPLACES all current data", args[0], from), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/restore", body, nil); err != nil {
				return err
			}
			output.Successf("restore started — poll `orchard db get %s` until status is ready", args[0])
			return nil
		},
	}
}

func dbBackupScheduleCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "backup-schedule",
		Aliases: []string{"schedule"},
		Short:   "Manage the automated backup schedule",
	}
	c.AddCommand(dbBackupScheduleGetCmd(), dbBackupScheduleSetCmd(), dbBackupScheduleClearCmd())
	return c
}

func dbBackupScheduleGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show the backup schedule",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/backup-schedule", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			cron := pick(raw, "cron")
			if cron == "" {
				cron = "(none)"
			}
			output.KV([][2]string{{"cron", cron}})
			return nil
		},
	}
}

func dbBackupScheduleSetCmd() *cobra.Command {
	var cron string
	var hourly, daily, weekly bool
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Set the backup schedule (--cron, or a preset)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			expr := cron
			// Presets match the documented UTC examples in the MCP tool.
			switch {
			case hourly:
				expr = "0 * * * *"
			case daily:
				expr = "0 2 * * *"
			case weekly:
				expr = "0 2 * * 0"
			}
			if expr == "" {
				return fmt.Errorf("pass --cron or one of --hourly/--daily/--weekly")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPut, "/databases/"+url.PathEscape(args[0])+"/backup-schedule", map[string]any{"cron": expr}, nil); err != nil {
				return err
			}
			output.Successf("backup schedule set to %q (UTC)", expr)
			return nil
		},
	}
	c.Flags().StringVar(&cron, "cron", "", "5-field cron expression in UTC")
	c.Flags().BoolVar(&hourly, "hourly", false, "backup every hour")
	c.Flags().BoolVar(&daily, "daily", false, "backup daily at 02:00 UTC")
	c.Flags().BoolVar(&weekly, "weekly", false, "backup weekly on Sunday 02:00 UTC")
	c.MarkFlagsMutuallyExclusive("cron", "hourly", "daily", "weekly")
	return c
}

func dbBackupScheduleClearCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "clear <id>",
		Short: "Disable automated backups (existing backups are kept)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/databases/"+url.PathEscape(args[0])+"/backup-schedule", nil, nil); err != nil {
				return err
			}
			output.Successf("backup schedule cleared")
			return nil
		},
	}
}

// dbWaitBackup polls the backups list until the given backup terminates; there
// is no single-backup GET endpoint, so WaitSpec can't be used here.
func dbWaitBackup(ctx context.Context, cl *api.Client, dbID, backupID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	last := ""
	for {
		var raw any
		if err := cl.GetJSON(ctx, "/databases/"+url.PathEscape(dbID)+"/backups", &raw); err != nil {
			return err
		}
		status := ""
		for _, b := range asList(raw) {
			if str(b["id"]) == backupID {
				status = pick(b, "status")
				break
			}
		}
		if status != "" && status != last {
			output.Warnf("status: %s", status)
			last = status
		}
		switch strings.ToLower(status) {
		case "completed":
			output.Successf("reached completed")
			return nil
		case "failed":
			return fmt.Errorf("backup reached %q", status)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("backup %s: %w", backupID, api.ErrWaitTimeout)
		}
		select {
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func dbHumanSize(v any) string {
	f, ok := v.(float64)
	if !ok || f <= 0 {
		return ""
	}
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	i := 0
	for f >= 1024 && i < len(units)-1 {
		f /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", f, units[i])
}
