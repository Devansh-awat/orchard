package commands

import (
	"fmt"
	"net"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const publicIPPath = "tenant.publicIp"

func PublicIP() *cli.Command {
	return &cli.Command{
		Name:    "public-ip",
		Args:    "...",
		Summary: "default address for publicly exposed ports",
		Root:    true,
		Usage: `orchardctl public-ip - default address for publicly exposed ports

Public TCP and UDP ports and public databases use an external address. An
organization can set its own. On a single-server install there is only one
address, so set it here. Without it, each organization must set its own.

  orchardctl public-ip           show it
  orchardctl public-ip set <ip>  set the instance-wide default
  orchardctl public-ip unset     go back to the Instance admin setting

An organization that sets its own address still uses that one. Instance admin
also has a field for this, under Configuration, which this command locks.

  orchardctl public-ip set 203.0.113.10 --apply
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)

			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				return err
			}

			action := "show"
			if len(args) > 0 {
				action = args[0]
			}

			switch action {
			case "show":
				current, _ := values.Get(publicIPPath).(string)
				if current == "" {
					c.Printf("Not pinned here. Orchard uses the address in Instance admin, under\n")
					c.Printf("Configuration, and with none there each organization sets its own.\n")
					c.Printf("Pin this server's public address with:\n")
					c.Printf("  orchardctl public-ip set <ip> --apply\n")
					return nil
				}
				c.Printf("%s\n", current)
				return nil

			case "set":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl public-ip set <ip>")
				}
				if net.ParseIP(args[1]) == nil {
					return fmt.Errorf("that isn't an IP address: %s", args[1])
				}
				if err := values.Set(publicIPPath, args[1]); err != nil {
					return err
				}
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("%s = %s\n", publicIPPath, args[1])

			case "unset":
				values.Unset(publicIPPath)
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("unset %s\n", publicIPPath)

			default:
				return fmt.Errorf("unknown public-ip command: %s", action)
			}

			return maybeApply(c, apply)
		},
	}
}
