package cmd

import (
	"errors"

	"github.com/LeafdTK/leaf/cli/internal/config"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func useCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "use <org|project|env> <id-or-slug>",
		GroupID: groupCore,
		Short:   "Set the default org/project/env for future commands",
		Long: "Writes a default scope to ~/.orchard/config.json so commands don't need\n" +
			"--org/--project/--env every time. Flags and ORCHARD_ORG/PROJECT/ENV still\n" +
			"override it per invocation.",
		Args:      cobra.ExactArgs(2),
		ValidArgs: []string{"org", "project", "env"},
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			switch args[0] {
			case "org", "organization":
				m, err := resolveOrg(ctx, cl, args[1])
				if err != nil {
					return err
				}
				if cfg.Context.OrgID != str(m["id"]) {
					cfg.Context = config.Context{}
				}
				cfg.Context.OrgID, cfg.Context.OrgSlug = str(m["id"]), str(m["slug"])
				output.Successf("using org %s", displayName(m))
			case "project", "proj":
				m, err := resolveProject(ctx, cl, args[1])
				if err != nil {
					return err
				}
				if cfg.Context.ProjectID != str(m["id"]) {
					cfg.Context.EnvID, cfg.Context.EnvName = "", ""
				}
				cfg.Context.ProjectID, cfg.Context.ProjectSlug = str(m["id"]), str(m["slug"])
				if orgID := str(m["organizationId"]); orgID != "" && orgID != cfg.Context.OrgID {
					cfg.Context.OrgID, cfg.Context.OrgSlug = orgID, ""
				}
				output.Successf("using project %s", displayName(m))
			case "env", "environment":
				projectID := cfg.Context.ProjectID
				if projectFlag != "" {
					pm, err := resolveProject(ctx, cl, projectFlag)
					if err != nil {
						return err
					}
					projectID = str(pm["id"])
				}
				if projectID == "" {
					return errors.New("set a project first: `orchard use project <slug>` (or pass --project)")
				}
				m, err := resolveEnv(ctx, cl, projectID, args[1])
				if err != nil {
					return err
				}
				cfg.Context.EnvID, cfg.Context.EnvName = str(m["id"]), str(m["name"])
				output.Successf("using environment %s", displayName(m))
			default:
				return cmd.Usage()
			}
			return cfg.Save()
		},
	}
	return c
}

func contextCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "context",
		GroupID: groupCore,
		Short:   "Show or clear the default scope set by `orchard use`",
	}
	show := &cobra.Command{
		Use:   "show",
		Short: "Show the current default scope",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(cfg.Context)
			}
			output.KV([][2]string{
				{"api", cfg.APIURL},
				{"org", labeled(cfg.Context.OrgSlug, cfg.Context.OrgID)},
				{"project", labeled(cfg.Context.ProjectSlug, cfg.Context.ProjectID)},
				{"env", labeled(cfg.Context.EnvName, cfg.Context.EnvID)},
			})
			return nil
		},
	}
	clear := &cobra.Command{
		Use:   "clear",
		Short: "Clear the default scope",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			cfg.Context = config.Context{}
			if err := cfg.Save(); err != nil {
				return err
			}
			output.Successf("context cleared")
			return nil
		},
	}
	c.AddCommand(show, clear)
	return c
}

func labeled(name, id string) string {
	switch {
	case name != "" && id != "":
		return name + " " + output.Dim("("+id+")")
	case id != "":
		return id
	default:
		return output.Dim("(unset)")
	}
}

func displayName(m map[string]any) string {
	if s := pick(m, "slug", "name", "id"); s != "" {
		return s
	}
	return "(unknown)"
}
