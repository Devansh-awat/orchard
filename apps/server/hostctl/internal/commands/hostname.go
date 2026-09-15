package commands

import (
	"fmt"
	"net"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const extraHostsPath = "ingress.extraHosts"

// Traefik routes the dashboard by Host header, so a box that is perfectly
// reachable at a name it was never told about answers 404 rather than serving
// anything. On a LAN install that is the common case: the installer knows the
// machine's addresses at install time, and nothing after that.
func Hostname() *cli.Command {
	return &cli.Command{
		Name:    "hostname",
		Args:    "...",
		Summary: "extra names the dashboard answers on",
		Root:    true,
		Usage: `orchardctl hostname - extra names the dashboard answers on

Traefik routes by Host header. A name that is not listed gets a 404 even
though the box is listening, which is what happens when you reach a LAN
install by a name the installer did not know about: a Tailscale name, an
mDNS name, a DNS record you added afterwards.

  orchardctl hostname                     list them
  orchardctl hostname add <name>          answer on one more
  orchardctl hostname remove <name>       stop answering on it

The primary hostname, the one links are generated with, is not in this list.
Change that one with:

  orchardctl config set ingress.host <name> --apply

These are matched, not certified. On an install that terminates TLS, a name
with no certificate covering it is a browser warning rather than a working
address, so they suit LAN and Tailscale names best.

  orchardctl hostname add mango --apply
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)

			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				return err
			}

			primary, _ := values.Get("ingress.host").(string)
			current := hostList(values)

			action := "list"
			if len(args) > 0 {
				action = args[0]
			}

			switch action {
			case "list":
				if primary != "" {
					c.Printf("%s (primary, used for generated links)\n", primary)
				}
				for _, h := range current {
					c.Printf("%s\n", h)
				}
				if len(current) == 0 {
					c.Printf("\nNo extra names. Add one with:\n")
					c.Printf("  orchardctl hostname add <name> --apply\n")
				}
				return nil

			case "add":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl hostname add <name>")
				}
				name, err := cleanHostname(args[1])
				if err != nil {
					return err
				}
				if name == primary {
					return fmt.Errorf("%s is already the primary hostname", name)
				}
				for _, h := range current {
					if h == name {
						return fmt.Errorf("%s is already in the list", name)
					}
				}
				current = append(current, name)
				saveHosts(values, current)
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("the dashboard now answers on %s\n", name)

			case "remove":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl hostname remove <name>")
				}
				name, err := cleanHostname(args[1])
				if err != nil {
					return err
				}
				kept := make([]string, 0, len(current))
				for _, h := range current {
					if h != name {
						kept = append(kept, h)
					}
				}
				if len(kept) == len(current) {
					return fmt.Errorf("%s is not in the list", name)
				}
				saveHosts(values, kept)
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("removed %s\n", name)

			default:
				return fmt.Errorf("unknown hostname command: %s", action)
			}

			return maybeApply(c, apply)
		},
	}
}

func hostList(values *cli.Values) []string {
	out := []string{}
	for _, item := range values.List(extraHostsPath) {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func saveHosts(values *cli.Values, hosts []string) {
	items := make([]any, 0, len(hosts))
	for _, h := range hosts {
		items = append(items, h)
	}
	values.SetList(extraHostsPath, items)
}

// cleanHostname takes what someone would paste, which is often a URL, and
// returns the bare name Traefik matches on.
func cleanHostname(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	name = strings.TrimPrefix(strings.TrimPrefix(name, "https://"), "http://")
	name = strings.TrimSuffix(strings.SplitN(name, "/", 2)[0], ".")
	if host, _, err := net.SplitHostPort(name); err == nil {
		name = host
	}
	if name == "" {
		return "", fmt.Errorf("that is not a hostname")
	}
	if net.ParseIP(name) != nil {
		return name, nil
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '.':
		default:
			return "", fmt.Errorf("that is not a hostname: %s", raw)
		}
	}
	return name, nil
}
