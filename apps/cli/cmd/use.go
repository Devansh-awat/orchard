package cmd

import (
	"errors"
	"fmt"
	"os"

	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/tui"
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
				output.Successf("using organization %s", displayName(m))
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
		Aliases: []string{"ctx"},
		GroupID: groupCore,
		Short:   "Switch between Orchard instances and show the default scope",
		Long: "A context is one Orchard instance: its URL, your token for it, and the default\n" +
			"org/project/env set by `orchard use`. `orchard auth login --api-url <url>` adds\n" +
			"one per instance. Pick the active one with `orchard context use`, or pass\n" +
			"--context / set ORCHARD_CONTEXT for a single command.",
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
			pairs := [][2]string{
				{"context", labeled(cfg.Name, "")},
				{"api", cfg.APIURL},
				{"org", labeled(cfg.Context.OrgSlug, cfg.Context.OrgID)},
				{"project", labeled(cfg.Context.ProjectSlug, cfg.Context.ProjectID)},
				{"env", labeled(cfg.Context.EnvName, cfg.Context.EnvID)},
			}
			if cwd, cerr := os.Getwd(); cerr == nil {
				if l, dir, ok := config.FindLink(cwd); ok {
					pairs = append(pairs,
						[2]string{"linked project", labeled(l.ProjectSlug, l.ProjectID) + " " + output.Dim("("+config.LinkPath(dir)+", overrides context)")},
					)
				}
			}
			output.KV(pairs)
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
	c.AddCommand(show, clear, contextListCmd(), contextUseCmd(), contextCurrentCmd(), contextRenameCmd(), contextRemoveCmd())
	return c
}

func contextListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the Orchard instances you have signed in to",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.LoadFile()
			if err != nil {
				return err
			}
			active := config.Selected(f)
			type row struct {
				Name     string `json:"name"`
				APIURL   string `json:"apiUrl"`
				Current  bool   `json:"current"`
				SignedIn bool   `json:"signedIn"`
				Org      string `json:"org,omitempty"`
			}
			rows := []row{}
			for _, name := range f.Names() {
				e := f.Contexts[name]
				rows = append(rows, row{
					Name:     name,
					APIURL:   e.APIURL,
					Current:  name == active,
					SignedIn: e.Token != "",
					Org:      e.Context.OrgSlug,
				})
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(rows)
			}
			if len(rows) == 0 {
				output.Println(output.Dim("no contexts yet: run `orchard auth login`"))
				return nil
			}
			table := [][]string{}
			for _, r := range rows {
				mark := ""
				if r.Current {
					mark = "*"
				}
				signed := "no"
				if r.SignedIn {
					signed = "yes"
				}
				table = append(table, []string{mark, r.Name, r.APIURL, signed, r.Org})
			}
			output.Table([]string{"", "NAME", "URL", "SIGNED IN", "ORG"}, table)
			return nil
		},
	}
}

func contextUseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "use [name]",
		Short: "Make a context the active one (pick from a list without a name)",
		Args:  cobra.MaximumNArgs(1),
		ValidArgsFunction: func(cmd *cobra.Command, args []string, _ string) ([]string, cobra.ShellCompDirective) {
			f, _ := config.LoadFile()
			return f.Names(), cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.LoadFile()
			if err != nil {
				return err
			}
			names := f.Names()
			if len(names) == 0 {
				return errors.New("no contexts yet: run `orchard auth login`")
			}
			var name string
			if len(args) == 1 {
				name = args[0]
			} else {
				if !output.IsTTY() || !output.StdinIsTTY() {
					return &exitcode.UsageError{Err: errors.New("pass a context name: `orchard context use <name>`")}
				}
				opts := make([]tui.PickOption, len(names))
				current := 0
				for i, n := range names {
					opts[i] = tui.PickOption{Group: "Orchard instances", Label: n, Detail: f.Contexts[n].APIURL}
					if n == f.Current {
						current = i
					}
				}
				i, ok, err := tui.PickOne("Switch Orchard context", opts, current)
				if err != nil {
					return err
				}
				if !ok {
					return nil
				}
				name = names[i]
			}
			if _, ok := f.Contexts[name]; !ok {
				return fmt.Errorf("no context named %q: run `orchard context list`", name)
			}
			f.Current = name
			if err := f.Save(); err != nil {
				return err
			}
			output.Successf("using context %s (%s)", name, f.Contexts[name].APIURL)
			return nil
		},
	}
}

func contextCurrentCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "current",
		Short: "Print the active context name",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.LoadFile()
			if err != nil {
				return err
			}
			name := config.Selected(f)
			if name == "" {
				return errors.New("no context yet: run `orchard auth login`")
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(map[string]string{"name": name, "apiUrl": f.Contexts[name].APIURL})
			}
			output.Println(name)
			return nil
		},
	}
}

func contextRenameCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rename <old> <new>",
		Short: "Rename a context",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.LoadFile()
			if err != nil {
				return err
			}
			from, to := args[0], args[1]
			e, ok := f.Contexts[from]
			if !ok {
				return fmt.Errorf("no context named %q", from)
			}
			if !config.ValidName(to) {
				return fmt.Errorf("invalid context name %q: use letters, numbers, dots, dashes or underscores", to)
			}
			if _, taken := f.Contexts[to]; taken {
				return fmt.Errorf("a context named %q already exists", to)
			}
			delete(f.Contexts, from)
			f.Contexts[to] = e
			if f.Current == from {
				f.Current = to
			}
			if err := f.Save(); err != nil {
				return err
			}
			output.Successf("renamed %s to %s", from, to)
			return nil
		},
	}
}

func contextRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <name>",
		Aliases: []string{"rm"},
		Short:   "Forget a context and its stored token",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := config.LoadFile()
			if err != nil {
				return err
			}
			name := args[0]
			if _, ok := f.Contexts[name]; !ok {
				return fmt.Errorf("no context named %q", name)
			}
			if err := output.Confirm(fmt.Sprintf("forget context %s and its token", name), yesFlag); err != nil {
				return err
			}
			delete(f.Contexts, name)
			if f.Current == name {
				f.Current = ""
				if rest := f.Names(); len(rest) > 0 {
					f.Current = rest[0]
				}
			}
			if err := f.Save(); err != nil {
				return err
			}
			output.Successf("removed context %s", name)
			return nil
		},
	}
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
