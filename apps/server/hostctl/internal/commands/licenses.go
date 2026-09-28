package commands

import (
	"io"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"github.com/hackclub/orchard/orchardctl/internal/notices"
)

func Licenses() *cli.Command {
	return &cli.Command{
		Name:    "licenses",
		Summary: "show the licenses of the open-source software built into orchardctl",
		Usage: `orchardctl licenses - print third-party notices

orchardctl is part of Orchard, free software under the GNU Affero General
Public License v3.0, with its source at https://github.com/hackclub/orchard.
This prints the copyright notices and license texts of the open-source code
compiled into this binary.
`,
		Run: func(c *cli.Context, args []string) error {
			_, err := io.WriteString(c.Stdout, notices.ThirdParty)
			return err
		},
	}
}
