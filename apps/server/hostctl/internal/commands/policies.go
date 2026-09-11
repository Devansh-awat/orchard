package commands

import (
	"fmt"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const ingressNamespacesPath = "tenant.ingressNamespaces"

func Policies() *cli.Command {
	return &cli.Command{
		Name:    "policies",
		Args:    "...",
		Summary: "which namespaces may reach tenant apps",
		Root:    true,
		Usage: `orchardctl policies - which namespaces may reach tenant apps

Every tenant namespace is default-deny, so the ingress controller has to be
named or it cannot reach the app. The symptom when it is wrong is not an
obviously dead site: it is a certificate that never issues, because the ACME
HTTP-01 solver is a pod in the tenant namespace and the controller cannot
reach it.

  orchardctl policies                     show the configured namespaces
  orchardctl policies set <ns>[,<ns>...]  change them
  orchardctl policies reapply             rewrite existing projects' policies

Policies are written when a namespace is created, so a change only reaches
new projects until it is re-applied. The server rewrites every namespace it
manages on boot, which is what reapply triggers.

  orchardctl policies set traefik,orchard --apply
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)

			action := "show"
			if len(args) > 0 {
				action = args[0]
			}

			switch action {
			case "show":
				values, err := cli.LoadValues(c.Env.Values)
				if err != nil {
					return err
				}
				current, _ := values.Get(ingressNamespacesPath).(string)
				if strings.TrimSpace(current) == "" {
					c.Printf("Not set, so the default applies: network,orchard\n")
					c.Printf("That is where this project runs HAProxy. On k3s with Traefik, run:\n")
					c.Printf("  orchardctl policies set traefik,orchard --apply\n")
					return nil
				}
				c.Printf("%s\n", current)
				return nil

			case "set":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl policies set <ns>[,<ns>...]")
				}
				values, err := cli.LoadValues(c.Env.Values)
				if err != nil {
					return err
				}
				if err := values.Set(ingressNamespacesPath, args[1]); err != nil {
					return err
				}
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("%s = %s\n", ingressNamespacesPath, args[1])
				if !apply {
					c.Printf("not deployed yet: run orchardctl update, then orchardctl policies reapply\n")
					return nil
				}
				if err := Update().Run(c, nil); err != nil {
					return err
				}
				return reapplyPolicies(c)

			case "reapply":
				return reapplyPolicies(c)
			}

			return fmt.Errorf("unknown policies command: %s", action)
		},
	}
}

// reapplyPolicies restarts the server rather than rewriting the policies here.
// The server already re-applies every managed namespace on boot, and a second
// implementation would be free to drift from the one that actually writes them.
func reapplyPolicies(c *cli.Context) error {
	c.Printf("restarting the server so it re-applies tenant policies...\n")
	if err := c.Kubectl("rollout", "restart", "deploy/server"); err != nil {
		return err
	}
	if err := c.Kubectl("rollout", "status", "deploy/server", "--timeout=5m"); err != nil {
		return err
	}
	c.Printf("done. check one with:\n")
	c.Printf("  kubectl -n <project-namespace> get networkpolicy default-deny-all -o yaml\n")
	return nil
}
