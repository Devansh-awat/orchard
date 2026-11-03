package cmd

import (
	"fmt"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "version",
		GroupID: groupUtility,
		Short:   "Print the CLI version",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if fmtFlag() == output.FormatJSON {
				return output.JSON(map[string]string{"version": Version})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "orchard version %s\n", Version)
			return nil
		},
	}
}
