package commands

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

// splitApply pulls --apply out of the argument list. Every mutating command
// accepts it, so an operator can batch edits and deploy once instead of
// rolling the cluster after each one.
func splitApply(args []string) ([]string, bool) {
	apply := false
	rest := args[:0:0]
	for _, a := range args {
		if a == "--apply" {
			apply = true
			continue
		}
		rest = append(rest, a)
	}
	return rest, apply
}

func maybeApply(c *cli.Context, apply bool) error {
	if !apply {
		return nil
	}
	return Update().Run(c, nil)
}

func Config() *cli.Command {
	return &cli.Command{
		Name:    "config",
		Args:    "...",
		Summary: "read and change chart values",
		Root:    true,
		Usage: `orchardctl config - read and change this instance's chart values

  orchardctl config get <path>          print one value
  orchardctl config set <path> <value>  change one value
  orchardctl config unset <path>        remove one value
  orchardctl config list                print the whole values file
  orchardctl config edit                open it in $EDITOR

Paths are dotted, e.g. signupMode or ingress.tls.issuerRef.name. Values are
parsed as YAML, so true and 3 keep their types while a bare word stays a
string.

Changes are written but not deployed. Add --apply to upgrade afterwards, or
run orchardctl update yourself once you have made every edit.

Lists cannot be set one path at a time, because the whole list would be
replaced. server.env holds the instance's secrets, so change it with
orchardctl env set <NAME> <value>, and anything else with config edit.

Common ones:
  signupMode                              open | invite_only | closed
  tenant.certClusterIssuer                ClusterIssuer for user app certificates
  ingress.tls.issuerRef.name              ClusterIssuer for the Orchard UI itself
  server.replicas                         control-plane API pods
  cilium.enabled                          Cilium-backed policy and basic auth
  metrics.enabled                         the built-in metrics stack
  metrics.victoriametrics.retention       how long metrics are kept, e.g. 7d
  logs.enabled                            the searchable log store
  logs.retention                          how long logs are kept, e.g. 14d
  logs.maxDiskSpaceUsage                  disk cap for logs, e.g. 8GiB
  logs.victorialogs.storage.storageClass  StorageClass for the log store
  trivy.enabled                           the Orchard image scanner
  trivy.maxConcurrentScans                scans running at once
  objectStorage.local.enabled             the S3 store backups go to on this box
  objectStorage.local.storage.size        its volume size, e.g. 40Gi
  r2Proxy.enabled                         the backup proxy databases talk to
  r2Proxy.upstream.endpoint               real S3/R2 for backups instead
  updates.url                             the what's-new feed, or off
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)
			if len(args) == 0 {
				return fmt.Errorf("usage: orchardctl config get|set|unset|list|edit")
			}

			switch args[0] {
			case "list":
				raw, err := os.ReadFile(c.Env.Values)
				if err != nil {
					return err
				}
				c.Printf("%s", raw)
				return nil

			case "edit":
				editor := os.Getenv("EDITOR")
				if editor == "" {
					editor = "vi"
				}
				cmd := exec.Command(editor, c.Env.Values)
				cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, c.Stdout, c.Stderr
				if err := cmd.Run(); err != nil {
					return err
				}
				return maybeApply(c, apply)
			}

			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				return err
			}

			switch args[0] {
			case "get":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl config get <path>")
				}
				if out := cli.Render(values.Get(args[1])); out != "" {
					c.Printf("%s\n", out)
				}
				return nil

			case "set":
				if len(args) != 3 {
					return fmt.Errorf("usage: orchardctl config set <path> <value>")
				}
				if err := values.Set(args[1], args[2]); err != nil {
					return err
				}
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("%s = %s\n", args[1], cli.Render(values.Get(args[1])))

			case "unset":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl config unset <path>")
				}
				if _, isList := values.Get(args[1]).([]any); isList && (args[1] == "env" || strings.HasSuffix(args[1], ".env")) {
					return &cli.ListPathError{Path: args[1], List: args[1], Verb: "unsetting"}
				}
				values.Unset(args[1])
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("unset %s\n", args[1])

			default:
				return fmt.Errorf("unknown config command: %s", strings.Join(args, " "))
			}

			return maybeApply(c, apply)
		},
	}
}
