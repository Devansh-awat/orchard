package cli

import (
	"fmt"
	"os"
	"sort"
	"strings"
)

// Command is one subcommand. Adding one is a matter of appending to the
// registry: the dispatcher derives help, root-gating and the hyphenated alias
// from this, so nothing else has to be kept in step.
type Command struct {
	Name string
	// Summary is one line, shown in the top-level listing.
	Summary string
	// Args is the argument sketch shown next to Name, e.g. "[service]".
	Args string
	// Usage is the long help, printed for `orchardctl <name> --help`.
	Usage string
	// Root marks a command that touches the 0600 values file or the cluster,
	// and so fails deep inside helm or kubectl when run unprivileged.
	Root bool
	Run  func(c *Context, args []string) error
}

type Registry struct {
	commands []*Command
}

func NewRegistry(commands ...*Command) *Registry {
	r := &Registry{commands: commands}
	sort.SliceStable(r.commands, func(i, j int) bool { return false })
	return r
}

func (r *Registry) Lookup(name string) *Command {
	for _, c := range r.commands {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func (r *Registry) Usage() string {
	var b strings.Builder
	b.WriteString("orchardctl - operate this Orchard host\n\n")
	width := 0
	for _, c := range r.commands {
		if n := len(c.Name) + len(c.Args) + 1; n > width {
			width = n
		}
	}
	for _, c := range r.commands {
		left := c.Name
		if c.Args != "" {
			left += " " + c.Args
		}
		fmt.Fprintf(&b, "  %-*s  %s\n", width, left, c.Summary)
	}
	var rooted []string
	for _, c := range r.commands {
		if c.Root {
			rooted = append(rooted, c.Name)
		}
	}
	fmt.Fprintf(&b, "\n%s need root. Each also exists hyphenated, e.g.\n", joinWords(rooted))
	b.WriteString("orchard-update. Not to be confused with the `orchard` CLI, which deploys\n")
	b.WriteString("apps to any instance over its API.\n")
	return b.String()
}

func joinWords(words []string) string {
	switch len(words) {
	case 0:
		return "No commands"
	case 1:
		return words[0]
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}

// resolve picks the command name from how the binary was invoked, so the
// dispatch rule is testable without running a command.
func resolve(r *Registry, invokedAs string, argv []string) string {
	if invokedAs == "orchard-sync-commands" {
		invokedAs = "orchard-sync"
	}
	if sub, ok := strings.CutPrefix(invokedAs, "orchard-"); ok && r.Lookup(sub) != nil {
		return sub
	}
	if len(argv) > 0 {
		return argv[0]
	}
	return "help"
}

// Main dispatches argv. invokedAs lets the hyphenated aliases
// (orchard-update, orchard-config, ...) reuse the same binary: the name it was
// called by selects the command, so there is one implementation per command
// rather than a script per alias.
func Main(r *Registry, invokedAs string, argv []string) int {
	name, args := resolve(r, invokedAs, argv), argv
	if len(argv) > 0 && name == argv[0] {
		args = argv[1:]
	}

	switch name {
	case "help", "-h", "--help", "":
		fmt.Fprint(os.Stdout, r.Usage())
		return 0
	}

	cmd := r.Lookup(name)
	if cmd == nil {
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", name)
		fmt.Fprint(os.Stderr, r.Usage())
		return 1
	}

	for _, a := range args {
		if a == "-h" || a == "--help" {
			fmt.Fprint(os.Stdout, cmd.Usage)
			return 0
		}
	}

	if cmd.Root && os.Geteuid() != 0 {
		fmt.Fprintf(os.Stderr, "orchardctl %s needs root: sudo orchardctl %s %s\n",
			cmd.Name, cmd.Name, strings.Join(args, " "))
		return 1
	}

	ctx := &Context{Env: LoadEnv(), Stdout: os.Stdout, Stderr: os.Stderr}
	if err := cmd.Run(ctx, args); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		return 1
	}
	return 0
}
