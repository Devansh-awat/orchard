package cmd

import (
	"net/url"

	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func projectCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "project",
		Aliases: []string{"projects", "proj"},
		Short:   "Manage projects",
	}
	c.AddCommand(projectListCmd(), projectGetCmd())
	return c
}

func projectListCmd() *cobra.Command {
	var org string
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List projects",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := "/projects"
			if org != "" {
				path += "?orgId=" + url.QueryEscape(org)
			}
			var raw any
			if err := cl.GetJSON(path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, p := range asList(raw) {
				rows = append(rows, []string{
					pick(p, "id"),
					pick(p, "slug", "name"),
					pick(p, "name"),
					pick(p, "organizationId", "orgId"),
				})
			}
			output.Table([]string{"id", "slug", "name", "org"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&org, "org", "", "filter by organization id")
	return c
}

func projectGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a project",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON("/projects/"+url.PathEscape(args[0]), &raw); err != nil {
				return err
			}
			return output.JSON(raw)
		},
	}
}
