package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func envCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "env",
		GroupID: groupResources,
		Aliases: []string{"environment", "envs"},
		Short:   "Manage project environments",
	}
	c.AddCommand(
		envListCmd(),
		envGetCmd(),
		envCreateCmd(),
		envDeleteCmd(),
		envSetDefaultCmd(),
		envVarsCmd(),
		envPullCmd(),
	)
	return c
}

// envScope resolves the target environment: explicit arg > --env/context >
// the project's default environment.
func envScope(ctx context.Context, cl *api.Client, cfg *config.Config, explicit string) (map[string]any, error) {
	pid, err := requireProject(ctx, cl, cfg)
	if err != nil {
		return nil, err
	}
	v := explicit
	if v == "" {
		v = scopedEnv(cfg)
	}
	if v != "" {
		return resolveEnv(ctx, cl, pid, v)
	}
	var raw any
	if err := cl.GetJSON(ctx, "/projects/"+url.PathEscape(pid)+"/environments", &raw); err != nil {
		return nil, err
	}
	for _, e := range asList(raw) {
		if b, _ := e["isDefault"].(bool); b {
			return e, nil
		}
	}
	return nil, errors.New("no environment scope: pass --env or run `orchard use env <name>`")
}

func envCount(e map[string]any, key string) string {
	c, _ := e["_count"].(map[string]any)
	return pick(c, key)
}

func envListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List environments in the project",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			pid, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(pid)+"/environments", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, e := range asList(raw) {
				def := ""
				if b, _ := e["isDefault"].(bool); b {
					def = "✓"
				}
				rows = append(rows, []string{
					pick(e, "id"),
					pick(e, "name"),
					pick(e, "slug"),
					pick(e, "namespace"),
					def,
					envCount(e, "deployments"),
				})
			}
			output.Table([]string{"id", "name", "slug", "namespace", "default", "deployments"}, rows)
			return nil
		},
	}
}

func envGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get [name-or-id]",
		Short: "Show an environment",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			explicit := ""
			if len(args) > 0 {
				explicit = args[0]
			}
			env, err := envScope(cmd.Context(), cl, cfg, explicit)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(env)
			}
			output.KV([][2]string{
				{"id", pick(env, "id")},
				{"name", pick(env, "name")},
				{"slug", pick(env, "slug")},
				{"namespace", pick(env, "namespace")},
				{"default", pick(env, "isDefault")},
				{"production", pick(env, "isProduction")},
				{"deployments", envCount(env, "deployments")},
				{"databases", envCount(env, "databases")},
				{"ingresses", envCount(env, "ingresses")},
				{"created", pick(env, "createdAt")},
			})
			return nil
		},
	}
}

func envCreateCmd() *cobra.Command {
	var name, slug string
	c := &cobra.Command{
		Use:   "create",
		Short: "Create an environment in the project",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			pid, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"name": name}
			if slug != "" {
				body["slug"] = slug
			}
			var env map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/"+url.PathEscape(pid)+"/environments", body, &env); err != nil {
				return err
			}
			output.Successf("created environment %s (%s)", pick(env, "name"), pick(env, "id"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(env)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "environment name (required)")
	c.Flags().StringVar(&slug, "slug", "", "url-safe slug (defaults to the slugified name)")
	_ = c.MarkFlagRequired("name")
	return c
}

func envDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <name-or-id>",
		Aliases: []string{"rm"},
		Short:   "Delete an environment and its namespace",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			env, err := envScope(cmd.Context(), cl, cfg, args[0])
			if err != nil {
				return err
			}
			prompt := fmt.Sprintf("delete environment %s and everything in namespace %s", pick(env, "name"), pick(env, "namespace"))
			if err := output.Confirm(prompt, yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/environments/"+url.PathEscape(pick(env, "id")), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted environment %s", pick(env, "name"))
			return nil
		},
	}
}

func envSetDefaultCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-default <name-or-id>",
		Short: "Make an environment the project default",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			env, err := envScope(cmd.Context(), cl, cfg, args[0])
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, "/environments/"+url.PathEscape(pick(env, "id"))+"/set-default", nil, nil); err != nil {
				return err
			}
			output.Successf("%s is now the default environment", pick(env, "name"))
			return nil
		},
	}
}

func envVarsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "vars",
		Aliases: []string{"var"},
		Short:   "Manage shared environment variables",
	}
	c.AddCommand(envVarsGetCmd(), envVarsSetCmd(), envVarsUnsetCmd())
	return c
}

func envFetchVars(ctx context.Context, cl *api.Client, envID string) ([]map[string]any, error) {
	var raw any
	if err := cl.GetJSON(ctx, "/environments/"+url.PathEscape(envID)+"/shared-vars", &raw); err != nil {
		return nil, err
	}
	return asList(raw), nil
}

// envPutVars replaces the environment's shared-var set. The API is
// full-replace and GET never returns secret plaintext, so untouched secret
// values are carried over as write-only nulls.
func envPutVars(cmd *cobra.Command, cl *api.Client, env map[string]any, vars []map[string]any, carriedSecrets int, did string) error {
	sort.Slice(vars, func(i, j int) bool { return str(vars[i]["key"]) < str(vars[j]["key"]) })
	var resp map[string]any
	path := "/environments/" + url.PathEscape(pick(env, "id")) + "/shared-vars"
	if err := cl.Send(cmd.Context(), http.MethodPut, path, map[string]any{"vars": vars}, &resp); err != nil {
		return err
	}
	if carriedSecrets > 0 {
		output.Warnf("%d untouched secret var(s) carried over (values are write-only)", carriedSecrets)
	}
	for _, w := range asList(resp["warnings"]) {
		output.Warnf("unresolved reference ${shared.%s} in %s", pick(w, "missingRef"), pick(w, "key"))
	}
	output.Successf("%s in %s", did, pick(env, "name"))
	if fmtFlag() == output.FormatJSON {
		return output.JSON(resp)
	}
	return nil
}

func envVarsGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "get [env]",
		Aliases: []string{"list", "ls"},
		Short:   "List shared variables (secret values are write-only, never returned)",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			explicit := ""
			if len(args) > 0 {
				explicit = args[0]
			}
			env, err := envScope(cmd.Context(), cl, cfg, explicit)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/environments/"+url.PathEscape(pick(env, "id"))+"/shared-vars", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, v := range asList(raw) {
				val := pick(v, "value")
				sec := ""
				if b, _ := v["secret"].(bool); b {
					sec = "✓"
					val = output.Dim("(write-only)")
				} else if v["value"] == nil {
					val = output.Dim("(hidden)")
				}
				rows = append(rows, []string{pick(v, "key"), val, sec})
			}
			output.Table([]string{"key", "value", "secret"}, rows)
			return nil
		},
	}
}

func envVarsSetCmd() *cobra.Command {
	var file string
	var secret bool
	c := &cobra.Command{
		Use:   "set [KEY=VAL ...]",
		Short: "Set shared variables (merged into the existing set)",
		Args:  cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			updates := map[string]string{}
			if file != "" {
				fromFile, err := parseEnvFile(file)
				if err != nil {
					return err
				}
				for k, v := range fromFile {
					updates[k] = v
				}
			}
			fromArgs, err := parseKVArgs(args)
			if err != nil {
				return err
			}
			for k, v := range fromArgs {
				updates[k] = v
			}
			if len(updates) == 0 {
				return errors.New("nothing to set: pass KEY=VAL arguments or --file")
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			env, err := envScope(cmd.Context(), cl, cfg, "")
			if err != nil {
				return err
			}
			current, err := envFetchVars(cmd.Context(), cl, pick(env, "id"))
			if err != nil {
				return err
			}
			vars := []map[string]any{}
			carried := 0
			existingSecret := map[string]bool{}
			for _, v := range current {
				k := str(v["key"])
				b, _ := v["secret"].(bool)
				existingSecret[k] = b
				if _, updating := updates[k]; updating {
					continue
				}
				if b {
					carried++
				}
				vars = append(vars, v)
			}
			for k, val := range updates {
				vars = append(vars, map[string]any{
					"key":    k,
					"value":  val,
					"secret": secret || existingSecret[k],
				})
			}
			return envPutVars(cmd, cl, env, vars, carried, fmt.Sprintf("set %d variable(s)", len(updates)))
		},
	}
	c.Flags().StringVar(&file, "file", "", "read KEY=VALs from a dotenv file")
	c.Flags().BoolVar(&secret, "secret", false, "mark the variables being set as secret (write-only, encrypted at rest)")
	return c
}

func envVarsUnsetCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "unset KEY [KEY ...]",
		Aliases: []string{"rm", "remove"},
		Short:   "Remove shared variables",
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			env, err := envScope(cmd.Context(), cl, cfg, "")
			if err != nil {
				return err
			}
			current, err := envFetchVars(cmd.Context(), cl, pick(env, "id"))
			if err != nil {
				return err
			}
			remove := map[string]bool{}
			for _, k := range args {
				remove[k] = true
			}
			vars := []map[string]any{}
			carried := 0
			found := map[string]bool{}
			for _, v := range current {
				k := str(v["key"])
				if remove[k] {
					found[k] = true
					continue
				}
				if b, _ := v["secret"].(bool); b {
					carried++
				}
				vars = append(vars, v)
			}
			missing := []string{}
			for k := range remove {
				if !found[k] {
					missing = append(missing, k)
				}
			}
			if len(missing) > 0 {
				sort.Strings(missing)
				return fmt.Errorf("variable(s) not set: %s", strings.Join(missing, ", "))
			}
			prompt := fmt.Sprintf("remove %d shared variable(s) from %s", len(found), pick(env, "name"))
			if err := output.Confirm(prompt, yesFlag); err != nil {
				return err
			}
			return envPutVars(cmd, cl, env, vars, carried, fmt.Sprintf("removed %d variable(s)", len(found)))
		},
	}
}
