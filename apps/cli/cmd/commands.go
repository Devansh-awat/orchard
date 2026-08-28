package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// commandFlag is one flag of one command in the machine-readable dump.
// Persistent flags are usable by every descendant of the command that
// declares them; each entry lists its own flags plus the inherited ones.
type commandFlag struct {
	Name       string `json:"name"`
	Shorthand  string `json:"shorthand,omitempty"`
	Type       string `json:"type"`
	Default    string `json:"default"`
	Usage      string `json:"usage"`
	Persistent bool   `json:"persistent"`
}

// commandInfo is one node of the command tree. Name is the full invocation
// path without the binary name, e.g. "deploy env set".
type commandInfo struct {
	Name    string        `json:"name"`
	Short   string        `json:"short"`
	Use     string        `json:"use"`
	Aliases []string      `json:"aliases,omitempty"`
	Hidden  bool          `json:"hidden,omitempty"`
	Flags   []commandFlag `json:"flags"`
}

// commandsCmd dumps the whole command tree so agents and scripts can discover
// the CLI's surface without scraping --help. It only introspects the in-memory
// cobra tree: no config load, no network, no auth.
func commandsCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "commands",
		GroupID: groupUtility,
		Short:   "List every command in the CLI (full dump with -o json)",
		Long: "Walk the whole command tree and print it.\n\n" +
			"Table mode shows an indented tree of visible commands with their short\n" +
			"descriptions. JSON mode emits one entry per command (hidden ones\n" +
			"included) with its full name, aliases, and every flag it accepts:\n" +
			"name, shorthand, type, default, usage, and whether the flag is\n" +
			"persistent (declared here or inherited from an ancestor).",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if fmtFlag() == output.FormatJSON {
				return output.JSON(collectCommands(cmd.Root()))
			}
			renderCommandTree(cmd.Root(), 0)
			return nil
		},
	}
}

// commandFullName strips the binary name off cobra's command path:
// "orchard deploy env set" -> "deploy env set".
func commandFullName(c *cobra.Command) string {
	path := c.CommandPath()
	rootName := c.Root().Name()
	return strings.TrimPrefix(path, rootName+" ")
}

// commandFlags lists the flags a command accepts: its own persistent flags,
// persistent flags inherited from ancestors, and its local flags.
func commandFlags(c *cobra.Command) []commandFlag {
	flags := []commandFlag{}
	seen := map[string]bool{}
	add := func(persistent bool) func(f *pflag.Flag) {
		return func(f *pflag.Flag) {
			if seen[f.Name] {
				return
			}
			seen[f.Name] = true
			flags = append(flags, commandFlag{
				Name:       f.Name,
				Shorthand:  f.Shorthand,
				Type:       f.Value.Type(),
				Default:    f.DefValue,
				Usage:      f.Usage,
				Persistent: persistent,
			})
		}
	}
	c.PersistentFlags().VisitAll(add(true))
	c.InheritedFlags().VisitAll(add(true))
	c.LocalNonPersistentFlags().VisitAll(add(false))
	sort.Slice(flags, func(i, j int) bool { return flags[i].Name < flags[j].Name })
	return flags
}

// collectCommands flattens the tree into name-sorted entries (root excluded).
func collectCommands(root *cobra.Command) []commandInfo {
	infos := []commandInfo{}
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, sub := range c.Commands() {
			infos = append(infos, commandInfo{
				Name:    commandFullName(sub),
				Short:   sub.Short,
				Use:     sub.Use,
				Aliases: sub.Aliases,
				Hidden:  sub.Hidden,
				Flags:   commandFlags(sub),
			})
			walk(sub)
		}
	}
	walk(root)
	sort.Slice(infos, func(i, j int) bool { return infos[i].Name < infos[j].Name })
	return infos
}

// renderCommandTree prints the human view: an indented tree of visible
// commands with dimmed short descriptions.
func renderCommandTree(c *cobra.Command, depth int) {
	for _, sub := range c.Commands() {
		if sub.Hidden {
			continue
		}
		line := strings.Repeat("  ", depth) + sub.Name()
		if sub.Short != "" {
			line += "  " + output.Dim(sub.Short)
		}
		fmt.Println(line)
		renderCommandTree(sub, depth+1)
	}
}
