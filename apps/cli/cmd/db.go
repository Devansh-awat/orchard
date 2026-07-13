package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/LeafdTK/leaf/cli/internal/termsession"
	"github.com/coder/websocket"
	"github.com/spf13/cobra"
)

func dbCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "db",
		GroupID: groupResources,
		Aliases: []string{"database", "databases"},
		Short:   "Manage databases",
	}
	c.AddCommand(
		dbListCmd(),
		dbGetCmd(),
		dbCreateCmd(),
		dbDeleteCmd(),
		dbConnectionCmd(),
		dbMetricsCmd(),
		dbLogsCmd(),
		dbPsqlCmd(),
		dbBackupCmd(),
		dbBackupScheduleCmd(),
		dbExtensionCmd(),
		dbSettingsCmd(),
		dbPublicCmd(),
		dbResourcesCmd(),
		dbStorageCmd(),
	)
	return c
}

func dbListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List databases (scoped to the current project or org when set)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			path := "/databases"
			if v := scopedProject(cfg); v != "" {
				p, rerr := resolveProject(cmd.Context(), cl, v)
				if rerr != nil {
					return rerr
				}
				path = "/projects/" + url.PathEscape(str(p["id"])) + "/databases"
			} else if v := scopedOrg(cfg); v != "" {
				o, rerr := resolveOrg(cmd.Context(), cl, v)
				if rerr != nil {
					return rerr
				}
				path = "/databases?orgId=" + url.QueryEscape(str(o["id"]))
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, d := range asList(raw) {
				project := ""
				if p, ok := d["project"].(map[string]any); ok {
					project = pick(p, "slug", "name")
				}
				if project == "" {
					project = pick(d, "projectId")
				}
				rows = append(rows, []string{
					pick(d, "id"),
					pick(d, "name", "dbName"),
					pick(d, "mode", "type"),
					project,
					output.Status(pick(d, "status", "state")),
				})
			}
			output.Table([]string{"id", "name", "mode", "project", "status"}, rows)
			return nil
		},
	}
}

func dbGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a database",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			raw, err := dbFetch(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"status", output.Status(pick(raw, "status"))},
				{"mode", pick(raw, "mode")},
				{"project", pick(raw, "projectId")},
				{"storage", pick(raw, "storageSize")},
				{"host", pick(raw, "internalHost", "host")},
				{"database", pick(raw, "dbName")},
				{"user", pick(raw, "dbUser")},
				{"public", pick(raw, "publicEnabled")},
				{"namespace", pick(raw, "namespace")},
				{"created", pick(raw, "createdAt")},
			}
			if live, ok := raw["liveStatus"].(map[string]any); ok {
				pairs = append(pairs,
					[2]string{"ready", pick(live, "ready")},
					[2]string{"connections", pick(live, "connections")},
				)
			}
			output.KV(dbTrimEmpty(pairs))
			return nil
		},
	}
}

func dbCreateCmd() *cobra.Command {
	var (
		name, storage, restoreFrom, memory string
		cpu                                int
		wait                               *bool
		timeout                            *time.Duration
	)
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a PostgreSQL database in the current project",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"name": name}
			if storage != "" {
				body["storageSize"] = storage
			}
			if restoreFrom != "" {
				body["restoreFromUrl"] = restoreFrom
			}
			if cpu > 0 {
				body["cpuRequestMilli"] = cpu
			}
			if memory != "" {
				b, perr := dbParseMemory(memory)
				if perr != nil {
					return perr
				}
				body["memoryRequestBytes"] = b
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/"+url.PathEscape(projectID)+"/databases", body, &raw); err != nil {
				return err
			}
			id := str(raw["id"])
			output.Successf("created database %s (%s)", name, id)
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			}
			if *wait && id != "" {
				// The provisioning endpoint reconciles CNPG state server-side, so
				// polling it alone is enough to flip provisioning → ready.
				return runWait(cmd.Context(), cl, api.WaitSpec{
					Path:    "/databases/" + url.PathEscape(id) + "/provisioning",
					Field:   "status",
					Success: []string{"ready"},
					Failure: []string{"error"},
				}, *timeout)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "database display name (required)")
	c.Flags().StringVar(&storage, "storage", "", `storage size, e.g. "1Gi" (server default 1Gi)`)
	c.Flags().StringVar(&restoreFrom, "restore-from", "", "postgres:// URL to seed data from on first boot")
	c.Flags().IntVar(&cpu, "cpu", 0, "CPU request in millicores (e.g. 500)")
	c.Flags().StringVar(&memory, "memory", "", `memory request in bytes or with unit (e.g. "512Mi")`)
	_ = c.MarkFlagRequired("name")
	wait, timeout = addWaitFlags(c)
	return c
}

func dbDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a database and all its data",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("permanently delete database %s and ALL its data", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/databases/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted database %s", args[0])
			return nil
		},
	}
}

func dbConnectionCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "connection <id>",
		Aliases: []string{"conn"},
		Short:   "Show connection details and credentials",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			raw, err := dbFetch(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"host", pick(raw, "host")},
				{"port", pick(raw, "port")},
				{"database", pick(raw, "dbName")},
				{"user", pick(raw, "dbUser")},
				{"password", pick(raw, "dbPassword")},
				{"url", pick(raw, "connectionString")},
			}
			if pick(raw, "publicEnabled") == "true" {
				pairs = append(pairs,
					[2]string{"public host", pick(raw, "publicHostname", "publicIp")},
					[2]string{"public port", pick(raw, "publicPort")},
					[2]string{"public url", pick(raw, "publicConnectionString")},
				)
			}
			output.KV(dbTrimEmpty(pairs))
			return nil
		},
	}
}

func dbMetricsCmd() *cobra.Command {
	var start, end, step int64
	c := &cobra.Command{
		Use:   "metrics <id>",
		Short: "Show CPU/memory/network usage for the database pod",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			q := url.Values{}
			if start > 0 {
				q.Set("start", strconv.FormatInt(start, 10))
			}
			if end > 0 {
				q.Set("end", strconv.FormatInt(end, 10))
			}
			if step > 0 {
				q.Set("step", strconv.FormatInt(step, 10))
			}
			path := "/databases/" + url.PathEscape(args[0]) + "/metrics"
			if len(q) > 0 {
				path += "?" + q.Encode()
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			// Series live under "data": {start, end, step, data: {cpu, mem, rx, tx}}.
			data, _ := raw["data"].(map[string]any)
			pairs := [][2]string{}
			for _, s := range []struct{ key, label, unit string }{
				{"cpu", "cpu", "m"},
				{"mem", "memory", "MiB"},
				{"rx", "net rx", "KiB/s"},
				{"tx", "net tx", "KiB/s"},
			} {
				if y, n, ok := dbLastPoint(data, s.key); ok {
					pairs = append(pairs, [2]string{s.label, fmt.Sprintf("%.1f %s (%d samples)", y, s.unit, n)})
				}
			}
			if len(pairs) == 0 {
				output.Warnf("no metric samples in the window")
				return nil
			}
			output.KV(pairs)
			return nil
		},
	}
	c.Flags().Int64Var(&start, "start", 0, "window start (unix-ms, default end-1h)")
	c.Flags().Int64Var(&end, "end", 0, "window end (unix-ms, default now)")
	c.Flags().Int64Var(&step, "step", 0, "sample step in ms (default 30000)")
	return c
}

func dbLogsCmd() *cobra.Command {
	var tail int
	c := &cobra.Command{
		Use:   "logs <id>",
		Short: "Fetch PostgreSQL logs from the database pod",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			db, err := dbFetch(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			namespace := str(db["namespace"])
			pod := dbFirstPod(db)
			if namespace == "" || pod == "" {
				return fmt.Errorf("database has no running pod yet (status: %s)", pick(db, "status"))
			}
			q := url.Values{}
			q.Set("namespace", namespace)
			q.Set("container", "postgres")
			q.Set("tailLines", strconv.Itoa(tail))
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/pods/"+url.PathEscape(pod)+"/logs?"+q.Encode(), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			logs := str(raw["logs"])
			fmt.Print(logs)
			if logs != "" && !strings.HasSuffix(logs, "\n") {
				fmt.Println()
			}
			return nil
		},
	}
	c.Flags().IntVar(&tail, "tail", 200, "number of log lines to fetch")
	return c
}

func dbPsqlCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "psql <id>",
		Short: "Open an interactive psql session in the database pod",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !output.IsTTY() {
				return errors.New("db psql needs an interactive terminal (stdout is not a TTY)")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			db, err := dbFetch(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			namespace := str(db["namespace"])
			pod := dbFirstPod(db)
			if namespace == "" || pod == "" {
				return fmt.Errorf("database has no running pod yet (status: %s)", pick(db, "status"))
			}
			conn, err := cl.DialExec(cmd.Context(), pod, namespace, "postgres")
			if err != nil {
				return err
			}
			// The exec gateway always spawns a shell; exec into psql so quitting
			// psql ends the session. Credentials are platform-generated alnum.
			if cs := str(db["connectionString"]); cs != "" {
				if err := conn.Write(cmd.Context(), websocket.MessageText, []byte("exec psql \""+cs+"\"\n")); err != nil {
					return err
				}
			}
			return termsession.Run(cmd.Context(), conn, os.Stdin, os.Stdout)
		},
	}
}

func dbExtensionCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "extension",
		Aliases: []string{"extensions", "ext"},
		Short:   "Manage PostgreSQL extensions",
	}
	c.AddCommand(dbExtensionListCmd(), dbExtensionInstallCmd(), dbExtensionUninstallCmd())
	return c
}

func dbExtensionListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <id>",
		Aliases: []string{"ls"},
		Short:   "List available and installed extensions",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/extensions", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, e := range asList(raw["extensions"]) {
				installed := ""
				if b, ok := e["installed"].(bool); ok && b {
					installed = "yes"
				}
				rows = append(rows, []string{
					pick(e, "name"),
					installed,
					pick(e, "version"),
					pick(e, "defaultVersion"),
					pick(e, "comment"),
				})
			}
			output.Table([]string{"name", "installed", "version", "default", "comment"}, rows)
			if libs, ok := raw["sharedPreloadLibraries"].([]any); ok && len(libs) > 0 {
				names := make([]string, 0, len(libs))
				for _, l := range libs {
					names = append(names, str(l))
				}
				output.KV([][2]string{{"preload", strings.Join(names, ", ")}})
			}
			return nil
		},
	}
}

func dbExtensionInstallCmd() *cobra.Command {
	var preload bool
	c := &cobra.Command{
		Use:   "install <id> <name>",
		Short: "Install a PostgreSQL extension",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[1]}
			if preload {
				body["addToPreload"] = true
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/extensions", body, nil); err != nil {
				return err
			}
			output.Successf("installed extension %s", args[1])
			if preload {
				output.Warnf("added to shared_preload_libraries — the database is restarting")
			}
			return nil
		},
	}
	c.Flags().BoolVar(&preload, "preload", false, "add to shared_preload_libraries (causes a database restart)")
	return c
}

func dbExtensionUninstallCmd() *cobra.Command {
	var removePreload bool
	c := &cobra.Command{
		Use:   "uninstall <id> <name>",
		Short: "Drop a PostgreSQL extension (and objects depending on it)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("drop extension %s — dependent objects will be dropped too", args[1]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := "/databases/" + url.PathEscape(args[0]) + "/extensions/" + url.PathEscape(args[1])
			if removePreload {
				path += "?removeFromPreload=true"
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			output.Successf("uninstalled extension %s", args[1])
			return nil
		},
	}
	c.Flags().BoolVar(&removePreload, "remove-preload", false, "also remove from shared_preload_libraries (causes a database restart)")
	return c
}

func dbSettingsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "settings",
		Short: "Read or update PostgreSQL parameters",
	}
	c.AddCommand(dbSettingsGetCmd(), dbSettingsSetCmd())
	return c
}

func dbSettingsGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show configured PostgreSQL parameters",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/settings", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			params, _ := raw["parameters"].(map[string]any)
			keys := make([]string, 0, len(params))
			for k := range params {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			pairs := [][2]string{}
			for _, k := range keys {
				pairs = append(pairs, [2]string{k, str(params[k])})
			}
			if len(pairs) == 0 {
				output.Warnf("no parameters configured")
				return nil
			}
			output.KV(pairs)
			return nil
		},
	}
}

func dbSettingsSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <id> KEY=VAL...",
		Short: "Update PostgreSQL parameters (KEY= removes a parameter)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			updates, err := parseKVArgs(args[1:])
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			// PATCH replaces the whole parameter map server-side, so merge with
			// the current values instead of clobbering them.
			var current map[string]any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0])+"/settings", &current); err != nil {
				return err
			}
			merged := map[string]string{}
			if params, ok := current["parameters"].(map[string]any); ok {
				for k, v := range params {
					merged[k] = str(v)
				}
			}
			for k, v := range updates {
				if v == "" {
					delete(merged, k)
				} else {
					merged[k] = v
				}
			}
			body := map[string]any{"parameters": merged}
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/databases/"+url.PathEscape(args[0])+"/settings", body, nil); err != nil {
				return err
			}
			output.Successf("updated %d parameter(s)", len(updates))
			return nil
		},
	}
}

func dbPublicCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "public",
		Short: "Manage public (internet) exposure",
	}
	c.AddCommand(dbPublicEnableCmd(), dbPublicDisableCmd())
	return c
}

func dbPublicEnableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "enable <id>",
		Short: "Expose the database publicly with TLS",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/databases/"+url.PathEscape(args[0])+"/public", map[string]any{}, &raw); err != nil {
				return err
			}
			output.Successf("public access enabled")
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV(dbTrimEmpty([][2]string{
				{"host", pick(raw, "host", "publicHostname")},
				{"port", pick(raw, "port", "publicPort")},
				{"url", pick(raw, "connectionString", "publicConnectionString")},
			}))
			return nil
		},
	}
}

func dbPublicDisableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "disable <id>",
		Short: "Stop exposing the database publicly",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/databases/"+url.PathEscape(args[0])+"/public", nil, nil); err != nil {
				return err
			}
			output.Successf("public access disabled")
			return nil
		},
	}
}

func dbResourcesCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "resources",
		Short: "Manage CPU/memory requests",
	}
	c.AddCommand(dbResourcesSetCmd())
	return c
}

func dbResourcesSetCmd() *cobra.Command {
	var cpu int
	var memory string
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Update CPU/memory requests (restarts the database pod)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !cmd.Flags().Changed("cpu") && !cmd.Flags().Changed("memory") {
				return errors.New("pass --cpu and/or --memory")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if cmd.Flags().Changed("cpu") {
				if cpu > 0 {
					body["cpuRequestMilli"] = cpu
				} else {
					body["cpuRequestMilli"] = nil
				}
			}
			if cmd.Flags().Changed("memory") {
				if memory == "0" || memory == "" {
					body["memoryRequestBytes"] = nil
				} else {
					b, perr := dbParseMemory(memory)
					if perr != nil {
						return perr
					}
					body["memoryRequestBytes"] = b
				}
			}
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/databases/"+url.PathEscape(args[0])+"/resources", body, nil); err != nil {
				return err
			}
			output.Successf("updated resources for %s", args[0])
			return nil
		},
	}
	c.Flags().IntVar(&cpu, "cpu", 0, "CPU request in millicores (0 clears back to default)")
	c.Flags().StringVar(&memory, "memory", "", `memory request in bytes or with unit ("512Mi"; 0 clears)`)
	return c
}

func dbStorageCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "storage",
		Short: "Manage the storage volume",
	}
	c.AddCommand(dbStorageExpandCmd())
	return c
}

func dbStorageExpandCmd() *cobra.Command {
	var size string
	c := &cobra.Command{
		Use:   "expand <id>",
		Short: "Grow the storage volume (never shrinks)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/databases/"+url.PathEscape(args[0])+"/storage", map[string]any{"storageSize": size}, &raw); err != nil {
				return err
			}
			output.Successf("storage expansion to %s started", size)
			if w := str(raw["warning"]); w != "" {
				output.Warnf("%s", w)
			}
			return nil
		},
	}
	c.Flags().StringVar(&size, "size", "", `new volume size, e.g. "10Gi" (required)`)
	_ = c.MarkFlagRequired("size")
	return c
}

// dbFetch loads the full database detail object (connection info, namespace,
// pods, liveStatus).
func dbFetch(ctx context.Context, cl *api.Client, id string) (map[string]any, error) {
	var raw map[string]any
	if err := cl.GetJSON(ctx, "/databases/"+url.PathEscape(id), &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// dbFirstPod mirrors the frontend Terminal tab: the first pod of the cluster
// is the primary.
func dbFirstPod(db map[string]any) string {
	pods, _ := db["pods"].([]any)
	if len(pods) == 0 {
		return ""
	}
	pod, _ := pods[0].(map[string]any)
	return str(pod["name"])
}

func dbTrimEmpty(pairs [][2]string) [][2]string {
	out := make([][2]string, 0, len(pairs))
	for _, p := range pairs {
		if p[1] != "" {
			out = append(out, p)
		}
	}
	return out
}

// dbParseMemory accepts plain bytes or binary-suffixed quantities (Ki/Mi/Gi/Ti).
func dbParseMemory(s string) (int64, error) {
	for suffix, mult := range map[string]int64{"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40} {
		if v, ok := strings.CutSuffix(s, suffix); ok {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n <= 0 {
				return 0, fmt.Errorf("invalid memory quantity %q", s)
			}
			return n * mult, nil
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid memory quantity %q (want bytes or Ki/Mi/Gi/Ti)", s)
	}
	return n, nil
}

func dbLastPoint(raw map[string]any, key string) (y float64, n int, ok bool) {
	pts, isList := raw[key].([]any)
	if !isList || len(pts) == 0 {
		return 0, 0, false
	}
	last, isMap := pts[len(pts)-1].(map[string]any)
	if !isMap {
		return 0, len(pts), false
	}
	y, ok = last["y"].(float64)
	return y, len(pts), ok
}
