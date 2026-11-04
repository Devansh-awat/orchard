package commands

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const egressPath = "builders.registryEgress"

// Destination is one entry in builders.registryEgress: a namespace the builder
// may push to, optionally narrowed to particular pods and ports.
type Destination struct {
	Namespace string
	Labels    map[string]string
	Ports     []int
}

func (d Destination) toMap() map[string]any {
	out := map[string]any{"namespace": d.Namespace}
	if len(d.Labels) > 0 {
		labels := map[string]any{}
		for k, v := range d.Labels {
			labels[k] = v
		}
		out["podLabels"] = labels
	}
	if len(d.Ports) > 0 {
		ports := make([]any, 0, len(d.Ports))
		for _, p := range d.Ports {
			ports = append(ports, map[string]any{"port": p})
		}
		out["ports"] = ports
	}
	return out
}

func parseDestination(args []string) (Destination, error) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return Destination{}, fmt.Errorf("usage: orchardctl registry allow <namespace> [--label k=v] [--port n]")
	}
	d := Destination{Namespace: args[0], Labels: map[string]string{}}

	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "--label":
			if i+1 >= len(args) {
				return d, fmt.Errorf("--label needs a key=value")
			}
			i++
			k, v, ok := strings.Cut(args[i], "=")
			if !ok || k == "" {
				return d, fmt.Errorf("labels look like key=value: %s", args[i])
			}
			d.Labels[k] = v
		case "--port":
			if i+1 >= len(args) {
				return d, fmt.Errorf("--port needs a number")
			}
			i++
			p, err := strconv.Atoi(args[i])
			if err != nil {
				return d, fmt.Errorf("ports are numbers: %s", args[i])
			}
			d.Ports = append(d.Ports, p)
		default:
			return d, fmt.Errorf("unknown option: %s", args[i])
		}
	}
	return d, nil
}

// upsert replaces any entry for the same namespace rather than adding a second
// one, so running allow twice does not leave two rules to reconcile by hand.
func upsert(values *cli.Values, d Destination) {
	kept := []any{}
	for _, item := range values.List(egressPath) {
		entry, ok := item.(map[string]any)
		if ok && entry["namespace"] == d.Namespace {
			continue
		}
		kept = append(kept, item)
	}
	values.SetList(egressPath, append(kept, d.toMap()))
}

func Registry() *cli.Command {
	return &cli.Command{
		Name:    "registry",
		Args:    "...",
		Summary: "where builds are allowed to push",
		Root:    true,
		Usage: `orchardctl registry - where builds are allowed to push

Builds run firewalled off from the rest of the cluster, so the registry they
push to has to be named here or the push is refused after a successful build.

  orchardctl registry                        show the current destinations
  orchardctl registry allow <ns> [options]   add one
  orchardctl registry remove <ns>            drop one
  orchardctl registry zot                    the registry this installer ships

Options for allow:
  --label <k=v>    only pods carrying this label, repeatable
  --port <n>       only this port, repeatable

Changes are written but not deployed. Add --apply to upgrade afterwards.

  orchardctl registry zot --apply
  orchardctl registry allow my-registry --label app=registry --port 5000
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
				items := values.List(egressPath)
				if len(items) == 0 {
					c.Printf("No destinations set, so the chart's defaults apply:\n")
					c.Printf("  harbor, and the ingress controller in the network namespace.\n")
					c.Printf("Neither exists on a single-node install. Run: orchardctl registry zot\n")
					return nil
				}
				c.Printf("%s\n", cli.Render(items))
				return nil

			case "zot":
				// What install.sh deploys: zot in the release namespace on 5000.
				upsert(values, Destination{
					Namespace: c.Env.Namespace,
					Labels:    map[string]string{"app": "zot"},
					Ports:     []int{5000},
				})

			case "allow":
				d, err := parseDestination(args[1:])
				if err != nil {
					return err
				}
				upsert(values, d)

			case "remove":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl registry remove <namespace>")
				}
				before := len(values.List(egressPath))
				upsert(values, Destination{Namespace: args[1]})
				kept := []any{}
				for _, item := range values.List(egressPath) {
					if entry, ok := item.(map[string]any); ok && entry["namespace"] == args[1] {
						continue
					}
					kept = append(kept, item)
				}
				values.SetList(egressPath, kept)
				if err := values.Save(); err != nil {
					return err
				}
				if before == len(kept) {
					c.Printf("%s wasn't listed\n", args[1])
				} else {
					c.Printf("removed %s\n", args[1])
				}
				return maybeApply(c, apply)

			default:
				return fmt.Errorf("unknown registry command: %s", action)
			}

			if err := values.Save(); err != nil {
				return err
			}
			c.Printf("builds may now push to:\n%s\n", cli.Render(values.List(egressPath)))
			return maybeApply(c, apply)
		},
	}
}
