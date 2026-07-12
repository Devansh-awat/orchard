package cmd

import (
	"net/url"

	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func dbCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "db",
		GroupID: groupResources,
		Aliases: []string{"database", "databases"},
		Short:   "Manage databases",
	}
	c.AddCommand(dbListCmd(), dbGetCmd())
	return c
}

func dbListCmd() *cobra.Command {
	var project string
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List databases",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := "/databases"
			if project != "" {
				path = "/projects/" + url.PathEscape(project) + "/databases"
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
				rows = append(rows, []string{
					pick(d, "id"),
					pick(d, "name", "slug"),
					pick(d, "type", "engine", "kind"),
					output.Status(pick(d, "status", "state", "phase")),
				})
			}
			output.Table([]string{"id", "name", "type", "status"}, rows)
			return nil
		},
	}
	c.Flags().StringVarP(&project, "project", "p", "", "filter by project id")
	return c
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
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/databases/"+url.PathEscape(args[0]), &raw); err != nil {
				return err
			}
			return output.JSON(raw)
		},
	}
}
