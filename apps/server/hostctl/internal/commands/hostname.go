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

Traefik routes by Host header. A name that isn't listed gets a 404, even though the server is listening.
This happens when you reach a LAN install by a name the installer didn't know:
a Tailscale name, an mDNS name, or a DNS record you added later.

  orchardctl hostname                     list them
  orchardctl hostname add <name>          answer on one more
  orchardctl hostname remove <name>       stop answering on it
  orchardctl hostname set <name>          change the dashboard domain

The primary hostname, used for generated links, isn't in this list. set changes
it, along with FRONTEND_URL, and keeps the scheme and port this instance serves
on. Everyone signs in again, and passkeys stop working, because
they belong to the old name.

The other names get no certificate. On an install that terminates TLS, a name
with no certificate shows a browser warning, so they suit LAN and Tailscale
names best.

  orchardctl hostname add mango --apply
  orchardctl hostname set orchard.example.com --apply
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
					return nil
				}
				c.Printf("\nThis is the values file. What Traefik is serving right now:\n")
				c.Printf("  kubectl -n %s get ingressroute orchard -o jsonpath='{.spec.routes[0].match}'\n", c.Env.Namespace)
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
				c.Printf("added %s\n", name)
				reportPending(c, apply)

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
					return fmt.Errorf("%s isn't in the list", name)
				}
				saveHosts(values, kept)
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("removed %s\n", name)
				reportPending(c, apply)

			case "set":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl hostname set <name>")
				}
				name, err := setPrimaryHostname(values, args[1])
				if err != nil {
					return err
				}
				if err := values.Save(); err != nil {
					return err
				}
				reportPrimaryMove(c, values, primary, name)
				reportPending(c, apply)

			default:
				return fmt.Errorf("unknown hostname command: %s", action)
			}

			return maybeApply(c, apply)
		},
	}
}

// The list is the values file, not the cluster. Saying "the dashboard now
// answers on mango" before a helm upgrade has run is a lie that costs somebody
// an afternoon of 404s at a name they were told works.
func reportPending(c *cli.Context, apply bool) {
	if apply {
		return
	}
	c.Printf("written, not deployed yet. Run: orchardctl update\n")
}

func setPrimaryHostname(values *cli.Values, raw string) (string, error) {
	name, err := cleanHostname(raw)
	if err != nil {
		return "", err
	}
	name = strings.ToLower(name)

	if installMode(values) != "lan" && !isDomainName(name) {
		return "", fmt.Errorf("%s isn't a domain. This install needs a name such as orchard.example.com", name)
	}
	if primary, _ := values.Get("ingress.host").(string); name == primary {
		return "", fmt.Errorf("%s is already the dashboard domain", name)
	}
	if mcp, _ := values.Get(mcpHostPath).(string); name == mcp {
		return "", fmt.Errorf("the MCP endpoint is at %s, and the dashboard can't share it", name)
	}

	base, err := claimBase(values, name)
	if err != nil {
		return "", err
	}
	if err := values.Put("ingress.host", name); err != nil {
		return "", err
	}
	values.SetEnv(serverEnvPath, "FRONTEND_URL", base)

	kept := []string{}
	for _, h := range hostList(values) {
		if h != name {
			kept = append(kept, h)
		}
	}
	saveHosts(values, kept)
	return name, nil
}

func reportPrimaryMove(c *cli.Context, values *cli.Values, from, to string) {
	c.Printf("Dashboard moves from %s to %s. Everyone signs in again.\n", from, to)
	c.Printf("Passkeys belong to the old name and stop working. Use a password or 'sudo orchardctl login'.\n")
	c.Printf("The GitHub App and any SSO provider keep the old URL until you update them.\n")
	c.Printf("The custom domains target doesn't change.\n")
	c.Printf("%s stops answering. To keep it, run: orchardctl hostname add %s --apply\n", from, from)
	c.Printf("%s\n", dnsAdvice(values, to))
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
		return "", fmt.Errorf("that isn't a hostname")
	}
	if net.ParseIP(name) != nil {
		return name, nil
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '.':
		default:
			return "", fmt.Errorf("that isn't a hostname: %s", raw)
		}
	}
	return name, nil
}
