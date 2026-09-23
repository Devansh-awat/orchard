package cmd

import (
	"errors"
	"fmt"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/tui"
	"github.com/spf13/cobra"
)

func topCmd() *cobra.Command {
	var db, once bool
	c := &cobra.Command{
		Use:     "top <id>",
		GroupID: groupCore,
		Short:   "Live pods, resources and traffic for one app, or one database with --db",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			if once || !output.IsTTY() {
				if !once && !output.IsTTY() {
					return errors.New("top requires an interactive terminal; pass --once for a single snapshot")
				}
				text, err := tui.RenderTopOnce(cl, args[0], db, 120, 30)
				if err != nil {
					return err
				}
				fmt.Println(text)
				return nil
			}
			orgID, _ := requireOrg(cmd.Context(), cl, cfg)
			return tui.RunTop(cl, args[0], db, orgID)
		},
	}
	c.Flags().BoolVar(&db, "db", false, "the id is a database")
	c.Flags().BoolVar(&once, "once", false, "print one snapshot and exit")
	return c
}
