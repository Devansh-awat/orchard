package cmd

import (
	"io"

	"github.com/hackclub/orchard/cli/internal/notices"
	"github.com/spf13/cobra"
)

func licensesCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "licenses",
		GroupID: groupUtility,
		Short:   "Show the licenses of the open-source software built into this CLI",
		Long: "orchard is free software under the GNU Affero General Public License v3.0,\n" +
			"with its source at https://github.com/hackclub/orchard.\n\n" +
			"This prints the copyright notices and license texts of every open-source\n" +
			"package compiled into this binary.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := io.WriteString(cmd.OutOrStdout(), notices.ThirdParty)
			return err
		},
	}
}
