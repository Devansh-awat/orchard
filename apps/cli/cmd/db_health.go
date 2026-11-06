package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

const dbDiagnoseLogLines = 20

type dbDownError struct {
	name    string
	reasons []string
}

func (e *dbDownError) Error() string {
	msg := "database " + e.name + " is down"
	if len(e.reasons) > 0 {
		msg += ": " + strings.Join(e.reasons, "; ")
	}
	return msg
}

func (e *dbDownError) Unwrap() error { return api.ErrDeployCrashing }

func dbOnOff(flag, v string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "on", "true", "yes", "1", "enable", "enabled":
		return true, nil
	case "off", "false", "no", "0", "disable", "disabled":
		return false, nil
	}
	return false, &exitcode.UsageError{Err: fmt.Errorf("--%s takes on or off, got %q", flag, v)}
}

func dbOnOffLabel(v any) string {
	if b, ok := v.(bool); ok {
		if b {
			return "on"
		}
		return "off"
	}
	return ""
}

func dbDiagnoseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "diagnose <dbId>",
		Short: "Explain a database's health in one call (exits 10 when it is down)",
		Long: `Print a verdict (healthy, degraded, unprotected, down, hibernated or unknown) with the
reasons behind it, then instances, the last restart, storage, the backup window, the last
restore test, recent operations and the tail of the Postgres log.

-o json prints the full diagnosis. The command exits 10 when the verdict is down, so a
script can branch on it.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/diagnosis", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			} else {
				dbRenderDiagnosis(raw)
			}
			if strings.EqualFold(pick(raw, "verdict"), "down") {
				db, _ := raw["database"].(map[string]any)
				return &dbDownError{name: dbOr(pick(db, "name"), args[0]), reasons: dbStrings(raw["reasons"])}
			}
			return nil
		},
	}
}

func dbRenderDiagnosis(raw map[string]any) {
	db, _ := raw["database"].(map[string]any)
	dbLine := pick(db, "name")
	if id := pick(db, "id"); id != "" {
		dbLine += " (" + id + ")"
	}
	details := []string{}
	if s := pick(db, "status"); s != "" {
		details = append(details, output.Status(s))
	}
	if v := pick(db, "pgMajor"); v != "" {
		details = append(details, "postgres "+v)
	}
	if v := pick(db, "storageSize"); v != "" {
		details = append(details, v)
	}
	if len(details) > 0 {
		dbLine += ", " + strings.Join(details, ", ")
	}
	pairs := [][2]string{
		{"database", dbLine},
		{"verdict", output.Status(dbOr(pick(raw, "verdict"), "unknown"))},
	}
	for i, r := range dbStrings(raw["reasons"]) {
		key := ""
		if i == 0 {
			key = "reasons"
		}
		pairs = append(pairs, [2]string{key, "- " + r})
	}
	if in, ok := raw["instances"].(map[string]any); ok {
		line := fmt.Sprintf("%s of %s ready", dbOr(pick(in, "ready"), "0"), dbOr(pick(in, "wanted"), "?"))
		if p := pick(in, "primary"); p != "" {
			line += ", primary " + p
		}
		pairs = append(pairs, [2]string{"instances", line})
	}
	if lr, ok := raw["lastRestart"].(map[string]any); ok {
		line := pick(lr, "reason")
		if c := pick(lr, "exitCode"); c != "" {
			line += ", exit code " + c
		}
		if at := pick(lr, "at"); at != "" {
			line += " at " + at
		}
		if n := pick(lr, "restarts"); n != "" {
			line += " (" + n + " restarts)"
		}
		pairs = append(pairs, [2]string{"last restart", line})
	}
	if st, ok := raw["storage"].(map[string]any); ok {
		parts := []string{}
		if vol, ok := st["volume"].(map[string]any); ok {
			parts = append(parts, fmt.Sprintf("%s of %s used (%s%%)", pick(vol, "used"), pick(vol, "capacity"), pick(vol, "percent")))
		}
		if b, _ := st["writeGuard"].(bool); b {
			parts = append(parts, "write guard ON (read only)")
		}
		if n := pick(st, "walPendingSegments"); n != "" && n != "0" {
			parts = append(parts, n+" WAL segments waiting to archive")
		}
		if len(parts) > 0 {
			pairs = append(pairs, [2]string{"storage", strings.Join(parts, ", ")})
		}
	}
	if b, ok := raw["backups"].(map[string]any); ok {
		archiving := "not configured"
		if a, ok := b["archiving"].(map[string]any); ok {
			if okv, _ := a["ok"].(bool); okv {
				archiving = "ok"
			} else {
				archiving = "failing: " + dbOr(pick(a, "message"), "no detail")
			}
		}
		pairs = append(pairs, [2]string{"wal archiving", archiving})
		window := "nothing restorable"
		if from := pick(b, "recoverableFrom"); from != "" {
			window = from + " to " + dbOr(pick(b, "recoverableTo"), "?")
		}
		pairs = append(pairs,
			[2]string{"restorable", window},
			[2]string{"last backup", dbOr(pick(b, "lastBackupAt"), "never")},
			[2]string{"backup method", pick(b, "method")},
		)
		if t, ok := b["lastRestoreTest"].(map[string]any); ok {
			pairs = append(pairs, [2]string{"last restore test", dbRestoreTestLine(t)})
		} else {
			pairs = append(pairs, [2]string{"last restore test", "never"})
		}
	}
	if p, ok := raw["protection"].(map[string]any); ok {
		pairs = append(pairs, [2]string{"protection", dbProtectionLine(p)})
	}
	if p, ok := raw["pooler"].(map[string]any); ok {
		pairs = append(pairs, [2]string{"pooler", dbPoolerLine(p)})
	}
	if cps := asList(raw["checkpoints"]); len(cps) > 0 {
		latest := cps[0]
		pairs = append(pairs, [2]string{"checkpoints", fmt.Sprintf("%d recent, newest %s %s (%s)", len(cps), dbOr(pick(latest, "label"), pick(latest, "kind")), pick(latest, "createdAt"), pick(latest, "status"))})
	}
	output.KV(dbTrimEmpty(pairs))
	if ops := asList(raw["operations"]); len(ops) > 0 {
		output.Println()
		output.Println(output.Dim("recent operations"))
		dbRenderOperations(raw["operations"])
	}
	if tail := strings.TrimRight(pick(raw, "logTail"), "\n"); tail != "" {
		lines := strings.Split(tail, "\n")
		if len(lines) > dbDiagnoseLogLines {
			lines = lines[len(lines)-dbDiagnoseLogLines:]
		}
		output.Println()
		output.Println(output.Dim(fmt.Sprintf("last %d log lines", len(lines))))
		for _, l := range lines {
			output.Println(l)
		}
	}
}

func dbPoolerLine(p map[string]any) string {
	if b, _ := p["enabled"].(bool); !b {
		return "off"
	}
	parts := []string{"on"}
	if cfg, ok := p["config"].(map[string]any); ok {
		if m := pick(cfg, "poolMode"); m != "" {
			parts = append(parts, m+" mode")
		}
	}
	if r, ok := p["ready"].(bool); ok {
		if r {
			parts = append(parts, "ready")
		} else {
			parts = append(parts, "not ready")
		}
	}
	if ph := pick(p, "phase"); ph != "" {
		parts = append(parts, ph)
	}
	return strings.Join(parts, ", ")
}

func dbActivityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "activity <dbId>",
		Short: "Show open sessions and blocked queries (needs a deploy-scope token)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/activity", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			sessions := asList(raw["sessions"])
			rows := [][]string{}
			for _, s := range sessions {
				wait := pick(s, "waitType")
				if ev := pick(s, "waitEvent"); ev != "" {
					wait = strings.TrimPrefix(wait+"/"+ev, "/")
				}
				rows = append(rows, []string{
					pick(s, "pid"),
					pick(s, "user"),
					pick(s, "app"),
					pick(s, "client"),
					pick(s, "state"),
					wait,
					dbSeconds(s["transactionSeconds"]),
					dbSeconds(s["querySeconds"]),
					dbOneLine(pick(s, "query"), 60),
				})
			}
			output.Table([]string{"pid", "user", "app", "client", "state", "wait", "xact", "query time", "query"}, rows)
			summary := fmt.Sprintf("%d session(s)", len(sessions))
			if m := pick(raw, "maxConnections"); m != "" {
				summary += " of max " + m
			}
			output.Println(output.Dim(summary))
			if blocked := asList(raw["blocked"]); len(blocked) > 0 {
				output.Println()
				output.Println(output.Dim("blocked"))
				brows := [][]string{}
				for _, b := range blocked {
					by := []string{}
					if list, ok := b["blockedBy"].([]any); ok {
						for _, p := range list {
							by = append(by, fmt.Sprint(p))
						}
					}
					brows = append(brows, []string{
						pick(b, "pid"),
						strings.Join(by, ","),
						dbSeconds(b["seconds"]),
						dbOneLine(pick(b, "query"), 80),
					})
				}
				output.Table([]string{"pid", "blocked by", "waiting", "query"}, brows)
			}
			return nil
		},
	}
}

func dbSeconds(v any) string {
	f, ok := v.(float64)
	if !ok {
		return ""
	}
	return strconv.FormatFloat(f, 'f', 0, 64) + "s"
}

func dbOneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > limit {
		return string(r[:limit-1]) + "…"
	}
	return s
}

func dbProtectCmd() *cobra.Command {
	var deletion, ddl, tests string
	c := &cobra.Command{
		Use:   "protect <dbId>",
		Short: "Show or change deletion protection, DDL checkpoints and scheduled restore tests",
		Long: `With no flags, shows the current settings.

--deletion on refuses ` + "`orchard db delete`" + ` until it is turned off again.
--ddl-checkpoints on takes a checkpoint before any DROP TABLE, DROP SCHEMA or DROP COLUMN.
--restore-tests on restores the latest backup into a throwaway copy on a schedule and checks it.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			for _, f := range []struct{ flag, key, val string }{
				{"deletion", "deletionProtection", deletion},
				{"ddl-checkpoints", "ddlCheckpoints", ddl},
				{"restore-tests", "restoreTests", tests},
			} {
				if !cmd.Flags().Changed(f.flag) {
					continue
				}
				b, err := dbOnOff(f.flag, f.val)
				if err != nil {
					return err
				}
				body[f.key] = b
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if len(body) == 0 {
				db, ferr := dbFetch(cmd.Context(), cl, args[0])
				if ferr != nil {
					return ferr
				}
				raw = map[string]any{
					"id":                 db["id"],
					"deletionProtection": db["deletionProtection"],
					"ddlCheckpoints":     db["ddlCheckpoints"],
					"restoreTests":       db["restoreTests"],
				}
			} else {
				if err := cl.Send(cmd.Context(), http.MethodPatch, "/databases/"+url.PathEscape(args[0])+"/protection", body, &raw); err != nil {
					return err
				}
				output.Successf("updated protection for %s", args[0])
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV(dbTrimEmpty([][2]string{
				{"deletion protection", dbOnOffLabel(raw["deletionProtection"])},
				{"ddl checkpoints", dbOnOffLabel(raw["ddlCheckpoints"])},
				{"restore tests", dbOnOffLabel(raw["restoreTests"])},
			}))
			return nil
		},
	}
	c.Flags().StringVar(&deletion, "deletion", "", "deletion protection: on|off")
	c.Flags().StringVar(&ddl, "ddl-checkpoints", "", "checkpoint before destructive DDL: on|off")
	c.Flags().StringVar(&tests, "restore-tests", "", "scheduled restore tests: on|off")
	return c
}

func dbPoolerCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "pooler",
		Short: "Manage the PgBouncer connection pooler in front of a database",
	}
	c.AddCommand(dbPoolerGetCmd(), dbPoolerSetCmd())
	return c
}

func dbRenderPooler(raw map[string]any) {
	cfg, _ := raw["config"].(map[string]any)
	pairs := [][2]string{
		{"enabled", dbOnOffLabel(raw["enabled"])},
		{"mode", pick(cfg, "poolMode")},
		{"instances", pick(cfg, "instances")},
		{"pool size", pick(cfg, "defaultPoolSize")},
		{"max client conn", pick(cfg, "maxClientConn")},
		{"host", pick(raw, "host")},
		{"port", pick(raw, "port")},
		{"ready", pick(raw, "ready")},
		{"phase", pick(raw, "phase")},
	}
	output.KV(dbTrimEmpty(pairs))
}

func dbPoolerGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <dbId>",
		Short: "Show the pooler's settings and state",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/pooler", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderPooler(raw)
			return nil
		},
	}
}

func dbPoolerSetCmd() *cobra.Command {
	var (
		enabled, mode                 string
		instances, poolSize, maxConns int
	)
	c := &cobra.Command{
		Use:   "set <dbId>",
		Short: "Turn the pooler on or off and change its settings",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("enabled") {
				b, err := dbOnOff("enabled", enabled)
				if err != nil {
					return err
				}
				body["enabled"] = b
			}
			if cmd.Flags().Changed("mode") {
				m := strings.ToLower(mode)
				if m != "transaction" && m != "session" {
					return &exitcode.UsageError{Err: fmt.Errorf("--mode takes transaction or session, got %q", mode)}
				}
				body["poolMode"] = m
			}
			if cmd.Flags().Changed("instances") {
				body["instances"] = instances
			}
			if cmd.Flags().Changed("pool-size") {
				body["defaultPoolSize"] = poolSize
			}
			if cmd.Flags().Changed("max-client-conn") {
				body["maxClientConn"] = maxConns
			}
			if len(body) == 0 {
				return &exitcode.UsageError{Err: errors.New("pass at least one of --enabled, --mode, --instances, --pool-size or --max-client-conn")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPut, "/databases/"+url.PathEscape(args[0])+"/pooler", body, &raw); err != nil {
				return err
			}
			output.Successf("updated pooler for %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderPooler(raw)
			return nil
		},
	}
	c.Flags().StringVar(&enabled, "enabled", "", "run the pooler: on|off")
	c.Flags().StringVar(&mode, "mode", "", "pool mode: transaction|session")
	c.Flags().IntVar(&instances, "instances", 0, "pooler instances (1-3)")
	c.Flags().IntVar(&poolSize, "pool-size", 0, "server connections per user and database (1-100)")
	c.Flags().IntVar(&maxConns, "max-client-conn", 0, "client connections the pooler accepts (10-5000)")
	return c
}

func dbReplicationCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "replication",
		Short: "Show or change how standbys confirm writes (async, preferred or required)",
	}
	c.AddCommand(dbReplicationGetCmd(), dbReplicationSetCmd())
	return c
}

func dbRenderReplication(raw map[string]any) {
	output.KV(dbTrimEmpty([][2]string{
		{"mode", pick(raw, "mode")},
		{"instances", pick(raw, "instances")},
		{"sync standbys", pick(raw, "syncStandbys")},
	}))
}

func dbReplicationGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <dbId>",
		Short: "Show the replication mode",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/replication", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderReplication(raw)
			return nil
		},
	}
}

func dbReplicationSetCmd() *cobra.Command {
	var mode string
	c := &cobra.Command{
		Use:   "set <dbId>",
		Short: "Set the replication mode (preferred and required need at least 2 instances)",
		Long: `async: the primary doesn't wait for standbys.
preferred: the primary waits for a standby when one is up, and carries on alone when none is.
required: every commit waits for a standby, so writes stop when no standby is up.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			m := strings.ToLower(mode)
			if m != "async" && m != "preferred" && m != "required" {
				return &exitcode.UsageError{Err: fmt.Errorf("--mode takes async, preferred or required, got %q", mode)}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/databases/"+url.PathEscape(args[0])+"/replication", map[string]any{"mode": m}, &raw); err != nil {
				return err
			}
			output.Successf("replication for %s set to %s", args[0], m)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			dbRenderReplication(raw)
			return nil
		},
	}
	c.Flags().StringVar(&mode, "mode", "", "async|preferred|required (required)")
	_ = c.MarkFlagRequired("mode")
	return c
}

func dbUserCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "user",
		Aliases: []string{"users"},
		Short:   "Manage extra Postgres users with read or write access",
	}
	c.AddCommand(dbUserListCmd(), dbUserCreateCmd(), dbUserRemoveCmd())
	return c
}

func dbUserListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <dbId>",
		Aliases: []string{"ls"},
		Short:   "List the extra users of a database",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/users", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, u := range asList(raw) {
				rows = append(rows, []string{pick(u, "name"), pick(u, "access"), pick(u, "present")})
			}
			output.Table([]string{"name", "access", "present"}, rows)
			return nil
		},
	}
}

func dbUserCreateCmd() *cobra.Command {
	var access string
	c := &cobra.Command{
		Use:   "create <dbId> <name>",
		Short: "Create a user and print its password once (needs a deploy-scope token)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			a := strings.ToLower(access)
			if a != "read" && a != "write" {
				return &exitcode.UsageError{Err: fmt.Errorf("--access takes read or write, got %q", access)}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/users", map[string]any{"name": args[1], "access": a}, &raw); err != nil {
				return err
			}
			output.Successf("created user %s with %s access", pick(raw, "name"), pick(raw, "access"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV(dbTrimEmpty([][2]string{
				{"name", pick(raw, "name")},
				{"access", pick(raw, "access")},
				{"password", pick(raw, "password")},
				{"url", pick(raw, "connectionString")},
			}))
			output.Warnf("the password is shown once; store it now")
			return nil
		},
	}
	c.Flags().StringVar(&access, "access", "read", "read|write")
	return c
}

func dbUserRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "rm <dbId> <name>",
		Aliases: []string{"delete"},
		Short:   "Drop a user",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("drop user %s from database %s", args[1], args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/databases/"+url.PathEscape(args[0])+"/users/"+url.PathEscape(args[1]), nil, nil); err != nil {
				return err
			}
			output.Successf("dropped user %s", args[1])
			return nil
		},
	}
}
