package commands

import (
	"fmt"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

var envTargets = []string{"server", "frontend", "mcp"}

func envPathFor(args []string) ([]string, string, error) {
	target := "server"
	rest := args[:0:0]
	for i := 0; i < len(args); i++ {
		if args[i] != "--for" {
			rest = append(rest, args[i])
			continue
		}
		if i+1 >= len(args) {
			return nil, "", fmt.Errorf("--for needs one of %s", strings.Join(envTargets, ", "))
		}
		target = args[i+1]
		i++
	}
	for _, known := range envTargets {
		if target == known {
			return rest, target + ".env", nil
		}
	}
	return nil, "", fmt.Errorf("--for takes one of %s, not %s", strings.Join(envTargets, ", "), target)
}

func validEnvName(name string) error {
	if name == "" {
		return fmt.Errorf("an environment variable needs a name")
	}
	for i, r := range name {
		letter := r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z')
		if !letter && !(i > 0 && r >= '0' && r <= '9') {
			return fmt.Errorf("%q isn't an environment variable name", name)
		}
	}
	return nil
}

func runEnv(values *cli.Values, path string, args []string, out func(string, ...any)) (bool, error) {
	if len(args) == 0 {
		return false, fmt.Errorf("usage: orchardctl env get|set|unset|list")
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return false, fmt.Errorf("usage: orchardctl env list")
		}
		for _, name := range values.EnvNames(path) {
			out("%s\n", name)
		}
		return false, nil

	case "get":
		if len(args) != 2 {
			return false, fmt.Errorf("usage: orchardctl env get <NAME>")
		}
		for _, name := range values.EnvNames(path) {
			if name == args[1] {
				out("%s\n", values.EnvValue(path, args[1]))
				return false, nil
			}
		}
		return false, fmt.Errorf("%s isn't set in %s", args[1], path)

	case "set":
		if len(args) != 3 {
			return false, fmt.Errorf("usage: orchardctl env set <NAME> <value>")
		}
		if err := validEnvName(args[1]); err != nil {
			return false, err
		}
		if raw := values.Get(path); raw != nil {
			if _, ok := raw.([]any); !ok {
				return false, fmt.Errorf("%s isn't a list in the values file; fix it with orchardctl config edit", path)
			}
		}
		values.SetEnv(path, args[1], args[2])
		out("%s %s set\n", path, args[1])
		return true, nil

	case "unset":
		if len(args) != 2 {
			return false, fmt.Errorf("usage: orchardctl env unset <NAME>")
		}
		if !values.UnsetEnv(path, args[1]) {
			out("%s wasn't set in %s\n", args[1], path)
			return false, nil
		}
		out("unset %s %s\n", path, args[1])
		return true, nil
	}
	return false, fmt.Errorf("unknown env command: %s", strings.Join(args, " "))
}

func Env() *cli.Command {
	return &cli.Command{
		Name:    "env",
		Args:    "...",
		Summary: "read and change control-plane environment variables",
		Root:    true,
		Usage: `orchardctl env - read and change the control plane's environment variables

  orchardctl env list                   print the names that are set
  orchardctl env get <NAME>             print one value
  orchardctl env set <NAME> <value>     add it, or change it in place
  orchardctl env unset <NAME>           remove it

These edit server.env in the values file one entry at a time and leave every
other entry alone, which is what makes them safe: that list holds JWT_SECRET
and SECRETS_ENCRYPTION_KEY, and losing the second makes every secret already
stored unreadable. orchardctl config set refuses to touch the list for that
reason.

  --for server|frontend|mcp   edit frontend.env or mcp.env instead

Changes are written but not deployed. Add --apply to upgrade afterwards, or
run orchardctl update yourself once you have made every edit.

  sudo orchardctl env set SMTP_HOST smtp.example.com
  sudo orchardctl env set R2_BACKUP_BUCKET my-backups --apply
  sudo orchardctl env get FRONTEND_URL
  sudo orchardctl env unset UPDATES_URL --for server
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)
			args, path, err := envPathFor(args)
			if err != nil {
				return err
			}
			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				return err
			}
			changed, err := runEnv(values, path, args, c.Printf)
			if err != nil {
				return err
			}
			if changed {
				if err := values.Save(); err != nil {
					return err
				}
			}
			return maybeApply(c, apply)
		},
	}
}
