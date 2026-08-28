package cmd

import (
	"errors"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/tui"
	"github.com/spf13/cobra"
)

func uiCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "ui",
		GroupID: groupCore,
		Aliases: []string{"dash", "tui"},
		Short:   "Launch the interactive dashboard",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !output.IsTTY() {
				return errors.New("the dashboard requires an interactive terminal")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			return tui.Run(cl)
		},
	}
}
