package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployBindingsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "bindings",
		Short: "Databases and apps this app is connected to",
		Long: `A connection links an app to a database or another app on the project.
Env values reference it as ${{resource.<name>.<field>}} and are composed when
the pod starts, so a rotated password, a restored cluster or a changed port
reaches the app without re-saving env.

Database fields: connection_string, host, port, database, user, password.
App fields: url, host, port.`,
	}
	c.AddCommand(deployBindingsListCmd(), deployBindingsOptionsCmd(), deployBindCmd(), deployUnbindCmd())
	return c
}

func deployBindingsListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list <id>",
		Short: "List bindings",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "bindings"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, b := range asList(raw) {
				res, status := "", ""
				if r, ok := b["resource"].(map[string]any); ok {
					res = pick(r, "name")
					status = pick(r, "status")
				} else {
					res = output.Dim("(missing)")
				}
				rows = append(rows, []string{
					pick(b, "name"),
					pick(b, "resourceType"),
					res,
					status,
					pick(b, "endpoint"),
					strings.Join(asStrings(b["usedBy"]), ", "),
				})
			}
			if len(rows) == 0 {
				fmt.Println(output.Dim("Nothing connected. Add one with: orchard deploy bindings add <id> --database <name> | --app <name>"))
				return nil
			}
			output.Table([]string{"name", "type", "resource", "status", "endpoint", "used by"}, rows)
			return nil
		},
	}
}

func deployBindingsOptionsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "options <id>",
		Short: "Databases and apps on the project that can still be connected",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "bindings", "options"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, o := range asList(raw) {
				rows = append(rows, []string{pick(o, "resourceType"), pick(o, "name"), pick(o, "resourceId"), pick(o, "status"), pick(o, "endpoint"), pick(o, "suggestedName")})
			}
			output.Table([]string{"type", "resource", "id", "status", "endpoint", "suggested name"}, rows)
			return nil
		},
	}
}

func deployBindCmd() *cobra.Command {
	var database, app, name, envKey string
	var noEnv bool
	c := &cobra.Command{
		Use:   "add <id> (--database <name|id> | --app <name|id>)",
		Short: "Connect a database or another app and add the obvious variable",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			want, kind := strings.TrimSpace(database), "database"
			if want == "" {
				want, kind = strings.TrimSpace(app), "deployment"
			}
			if want == "" {
				return fmt.Errorf("one of --database or --app is required")
			}
			var options any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "bindings", "options"), &options); err != nil {
				return err
			}
			var match map[string]any
			for _, o := range asList(options) {
				if pick(o, "resourceType") != kind {
					continue
				}
				if pick(o, "resourceId") == want || strings.EqualFold(pick(o, "name"), want) {
					match = o
					break
				}
			}
			if match == nil {
				return fmt.Errorf("no unconnected %s %q on this app's project (see: orchard deploy bindings options %s)", kind, want, args[0])
			}
			body := map[string]any{
				"resourceType": kind,
				"resourceId":   pick(match, "resourceId"),
			}
			if name != "" {
				body["name"] = name
			}
			if !noEnv {
				key := envKey
				if key == "" && kind == "database" {
					key = "DATABASE_URL"
				} else if key == "" {
					alias := name
					if alias == "" {
						alias = pick(match, "suggestedName")
					}
					key = strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(alias)) + "_URL"
				}
				body["envKey"] = key
			}
			var out map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "bindings"), body, &out); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(out)
			}
			fmt.Printf("Connected to %s as %s\n", pick(match, "name"), pick(out, "name"))
			if k := pick(out, "addedEnvKey"); k != "" {
				field := "connection_string"
				if kind == "deployment" {
					field = "url"
				}
				fmt.Printf("Added %s=${{resource.%s.%s}}\n", k, pick(out, "name"), field)
			} else if !noEnv {
				fmt.Println(output.Dim("Env untouched: the key already exists."))
			}
			return nil
		},
	}
	c.Flags().StringVar(&database, "database", "", "database name or id on the same project")
	c.Flags().StringVar(&app, "app", "", "app name or id on the same project")
	c.Flags().StringVar(&name, "as", "", "binding name used in ${{resource.<name>.*}} (default: derived from the database name)")
	c.Flags().StringVar(&envKey, "env", "", "env key to add (default DATABASE_URL for a database, <NAME>_URL for an app)")
	c.Flags().BoolVar(&noEnv, "no-env", false, "bind only, don't add an env var")
	return c
}

func deployUnbindCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <id> <name>",
		Short: "Disconnect a resource",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "bindings"), &raw); err != nil {
				return err
			}
			id := ""
			for _, b := range asList(raw) {
				if pick(b, "name") == args[1] || pick(b, "id") == args[1] {
					id = pick(b, "id")
					break
				}
			}
			if id == "" {
				return fmt.Errorf("no binding named %q", args[1])
			}
			path := deployPath(args[0], "bindings", url.PathEscape(id))
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			fmt.Printf("Disconnected %s\n", args[1])
			return nil
		},
	}
}

func dbRotatePasswordCmd() *cobra.Command {
	var yes bool
	c := &cobra.Command{
		Use:   "rotate-password <id>",
		Short: "Set a new password and push it to every bound app",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if !yes {
				fmt.Println("Anything that copied the old connection string by hand stops working. Bound apps follow automatically.")
				fmt.Print("Rotate? [y/N] ")
				var answer string
				fmt.Scanln(&answer)
				if !strings.EqualFold(strings.TrimSpace(answer), "y") {
					return nil
				}
			}
			var out map[string]any
			path := "/databases/" + url.PathEscape(args[0]) + "/rotate-password"
			if err := cl.Send(cmd.Context(), http.MethodPost, path, map[string]any{}, &out); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(out)
			}
			names := []string{}
			for _, n := range asStrings(out["reapplied"]) {
				names = append(names, n)
			}
			if len(names) == 0 {
				fmt.Println("Password rotated. No apps were bound.")
			} else {
				fmt.Printf("Password rotated. Re-applied env to %s.\n", strings.Join(names, ", "))
			}
			return nil
		},
	}
	c.Flags().BoolVarP(&yes, "yes", "y", false, "skip the confirmation")
	return c
}

func asStrings(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, item := range list {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
