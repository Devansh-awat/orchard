package commands

import (
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
		Summary: "print a link to claim the instance and sign in",
		Root:    true,
		Usage: `orchardctl claim - claim this instance

Prints a single-use link that claims the instance and signs you in as the
superadmin. Use it on a fresh install, or if you have locked yourself out.
The link is minted inside the server pod, so it works with no email
configured.
`,
		Run: func(c *cli.Context, args []string) error {
			return c.Kubectl("exec", "deploy/server", "--", "node", "dist/scripts/mint-claim-link.js")
		},
	}
}

func Update() *cli.Command {
	return &cli.Command{
		Name:    "update",
		Summary: "upgrade to the latest chart and images",
		Root:    true,
		Usage: `orchardctl update - upgrade this instance

Runs helm upgrade --install with your values file, waits for each deployment
to roll out, then refreshes the host commands. Extra arguments are passed
through to helm.
`,
		Run: func(c *cli.Context, args []string) error {
			helmArgs := append([]string{
				"upgrade", "--install", "orchard", c.Env.Chart,
				"--namespace", c.Env.Namespace,
				"-f", c.Env.Values,
				"--timeout", "20m",
			}, args...)
			if err := c.Run("helm", helmArgs...); err != nil {
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

			// The host commands ship inside the server image, so a release that
			// changes them lands here rather than waiting for someone to re-run
			// the installer.
			if err := syncCommands(c); err != nil {
				c.Warnf("note: could not refresh the host commands: %s\n", err)
			}
			return nil
		},
	}
}
