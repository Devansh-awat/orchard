package commands

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

func Status() *cli.Command {
	return &cli.Command{
		Name:    "status",
		Summary: "show the control-plane pods",
		Usage:   "orchardctl status - show the control-plane pods\n",
		Run: func(c *cli.Context, args []string) error {
			return c.Kubectl("get", "pods")
		},
	}
}

func Logs() *cli.Command {
	return &cli.Command{
		Name:    "logs",
		Args:    "[service]",
		Summary: "follow logs (server, frontend, mcp; default server)",
		Usage: `orchardctl logs - follow a control-plane service's logs

  orchardctl logs            server
  orchardctl logs frontend
  orchardctl logs mcp

These are the control plane, not your apps. Use the Orchard UI or the
` + "`orchard`" + ` CLI for a deployment's logs.
`,
		Run: func(c *cli.Context, args []string) error {
			service := "server"
			if len(args) > 0 && args[0] != "" {
				service = args[0]
			}
			return c.Kubectl("logs", "-f", "deploy/"+service)
		},
	}
}

func Claim() *cli.Command {
	return &cli.Command{
		Name:    "claim",
		Args:    "[--url <address>]",
		Summary: "print a link to claim the instance and sign in",
		Root:    true,
		Usage: `orchardctl claim - claim this instance

Prints a single-use link that claims the instance and signs you in as the
superadmin. Use it on a fresh install, or if you have locked yourself out.
The server pod creates the link, so it works with no email set up.

The link is built from the hostname the instance generates links with, which
isn't always the one you can reach it at. --url overrides it:

  orchardctl claim --url mango
  orchardctl claim --url http://mango:8081
  orchardctl claim --url 192.168.4.27

A bare name takes the scheme and port this instance serves on. The address
has to be one Traefik answers on, so add it first if it is new:

  orchardctl hostname add mango --apply
`,
		Run: func(c *cli.Context, args []string) error {
			raw, err := flagValue(args, "--url")
			if err != nil {
				return err
			}
			exec := []string{"exec", "deploy/server", "--", "node", "dist/scripts/mint-claim-link.js"}
			if raw != "" {
				values, err := cli.LoadValues(c.Env.Values)
				if err != nil {
					return err
				}
				base, err := claimBase(values, raw)
				if err != nil {
					return err
				}
				exec = append(exec, "--url", base)
			}
			return c.Kubectl(exec...)
		},
	}
}

// flagValue pulls `--name <value>` out of an argument list. The host commands
// parse their own arguments rather than carrying a flag package.
func flagValue(args []string, name string) (string, error) {
	for i, a := range args {
		if a != name {
			continue
		}
		if i+1 >= len(args) {
			return "", fmt.Errorf("%s needs a value", name)
		}
		return args[i+1], nil
	}
	return "", nil
}

// claimBase turns what someone types into an origin the claim link can use.
// A full URL is taken as given; a bare name gets the scheme and port this
// instance actually serves on, which is the whole point of asking here rather
// than making the operator remember them.
func claimBase(values *cli.Values, raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", fmt.Errorf("--url needs an address")
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw, nil
	}

	scheme, port := servedOn(values)

	host, err := cleanHostname(raw)
	if err != nil {
		return "", err
	}
	if _, typed, splitErr := net.SplitHostPort(raw); splitErr == nil && typed != "" {
		port = typed
	}
	if port == "" {
		return fmt.Sprintf("%s://%s", scheme, host), nil
	}
	return fmt.Sprintf("%s://%s:%s", scheme, host, port), nil
}

// The scheme and port this instance is reached on. FRONTEND_URL first, because
// it is the address the server itself hands out and it is set on every install:
// the PUBLIC_*_PORT variables only appeared once custom ports did, so reading
// those alone silently drops the port on anything installed before that and
// hands back a link to a port nothing is listening on.
func servedOn(values *cli.Values) (string, string) {
	if front := values.EnvValue("server.env", "FRONTEND_URL"); front != "" {
		if u, err := url.Parse(front); err == nil && u.Scheme != "" {
			return u.Scheme, u.Port()
		}
	}

	tls, _ := values.Get("ingress.tls.enabled").(bool)
	scheme, standard, portVar := "http", "80", "PUBLIC_HTTP_PORT"
	if tls {
		scheme, standard, portVar = "https", "443", "PUBLIC_HTTPS_PORT"
	}
	port := values.EnvValue("server.env", portVar)
	if port == "" {
		port = values.EnvValue("frontend.env", portVar)
	}
	if port == standard {
		port = ""
	}
	return scheme, port
}

func Update() *cli.Command {
	return &cli.Command{
		Name:    "update",
		Summary: "upgrade to the latest chart and images",
		Root:    true,
		Usage: `orchardctl update - upgrade this instance

Runs orchardctl harden first, which fixes an install from before the registry
was locked down and the firewall was opened.

Then it turns on, once, what newer releases do by default: metrics, the log
store, the Orchard image scanner and, when no object storage is configured
anywhere, an S3 store on this server for database backups. Only keys missing from
the values file are filled in, apart from metrics.enabled and r2Proxy.enabled,
which older installers wrote as false themselves. An install with the bundled
zot registry but no builders.registryEgress entry for it gets one, since builds
can't push without it. Each change is printed. A
hostDefaults key records that this ran, so turning something back off sticks.

Then helm upgrade --install with your values file, waits for each deployment to
roll out, makes sure Traefik writes the JSON access log the log store reads,
and refreshes the host commands. Extra arguments are passed through to helm.

It also installs newer versions of what Orchard bundles without waiting on an
Orchard release: the latest k3s patch, Traefik, CloudNativePG and cert-manager
within their major versions, and the images the chart runs. See orchardctl k3s
--help and orchardctl images --help. To turn the add-on and image updates off, set
ORCHARD_ADDON_UPDATES=off in /etc/orchard/env.
`,
		Run: func(c *cli.Context, args []string) error {
			if err := harden(c); err != nil {
				return err
			}
			if err := migrateValues(c); err != nil {
				return err
			}
			imageChanges := refreshBundledImages(c)
			applyChart := func() error {
				helmArgs := []string{"upgrade", "--install", "orchard", c.Env.Chart, "--namespace", c.Env.Namespace}
				helmArgs = append(helmArgs, chartValueArgs(c)...)
				helmArgs = append(helmArgs, "--timeout", "20m")
				helmArgs = append(helmArgs, args...)
				helmArgs = append(helmArgs, clientSideApply(c)...)
				return c.Run("helm", helmArgs...)
			}
			if err := applyChart(); err != nil {
				return err
			}

			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				// An unreadable values file is not a reason to skip the
				// rollout: treat every tag as moving.
				values = nil
			}

			for _, deploy := range []string{"server", "frontend", "mcp"} {
				if _, err := c.KubectlOut("get", "deploy/"+deploy); err != nil {
					continue
				}

				// The installer pins tags to `latest`, so a new build reuses
				// the same tag string. Helm sees an identical pod template,
				// writes no new ReplicaSet, and nothing re-pulls: upgrade can
				// report success while the old image keeps running. An
				// unreadable tag counts as moving, because restarting a pinned
				// deployment costs one rollout while missing an update leaves a
				// fixed bug undeployed.
				moving := true
				if values != nil {
					if tag, ok := values.Get(deploy + ".image.tag").(string); ok {
						moving = tag == "" || tag == "latest"
					}
				}
				if moving {
					if err := c.Kubectl("rollout", "restart", "deploy/"+deploy); err != nil {
						return err
					}
				}
				if err := c.Kubectl("rollout", "status", "deploy/"+deploy, "--timeout=10m"); err != nil {
					return err
				}
			}

			revertFailedImages(c, imageChanges, applyChart)
			refreshFloatingWorkloads(c)

			ensureTraefikAccessLogs(c)

			// The host commands ship inside the server image, so a release that
			// changes them lands here rather than waiting for someone to re-run
			// the installer.
			if err := syncCommands(c); err != nil {
				c.Warnf("note: couldn't refresh the host commands: %s\n", err)
			}
			if err := patchK3s(c); err != nil {
				c.Warnf("note: k3s wasn't updated: %s\n", err)
			}
			upgradeAddons(c)
			return nil
		},
	}
}

func clientSideApply(c *cli.Context) []string {
	version, err := c.Capture("helm", "version", "--short")
	if err == nil && strings.HasPrefix(strings.TrimSpace(version), "v4.") {
		return []string{"--server-side=false"}
	}
	return nil
}
