package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/coder/websocket"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/termsession"
	"github.com/spf13/cobra"
)

// replFor maps a detected language to the REPL its official images ship
// with. An empty string means the language has no interactive REPL worth
// opening (compiled languages), so the caller should point at `pod shell`.
func replFor(language string) string {
	switch strings.ToLower(language) {
	case "node", "nodejs", "javascript", "typescript", "bun", "deno":
		return "node"
	case "python":
		return "python3"
	case "ruby":
		return "irb"
	case "php":
		return "php -a"
	case "elixir":
		return "iex"
	case "java", "kotlin":
		return "jshell"
	}
	return ""
}

func consoleCmd() *cobra.Command {
	var pod, repl string
	c := &cobra.Command{
		Use:     "console <deploymentId>",
		GroupID: groupCore,
		Aliases: []string{"repl"},
		Short:   "Open the app's language REPL inside a running pod",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !output.IsTTY() {
				return errors.New("console needs an interactive terminal (stdout is not a TTY)")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			if repl == "" {
				var rt map[string]any
				if err := cl.GetJSON(ctx, observePath(args[0], "runtime"), &rt); err != nil {
					return err
				}
				lang := pick(rt, "language")
				repl = replFor(lang)
				if repl == "" {
					if lang == "" || lang == "unknown" {
						return errors.New("could not detect the app's language; pass --repl <command>, or use `orchard pod shell`")
					}
					return fmt.Errorf("%s has no interactive REPL; use `orchard pod shell` instead, or pass --repl <command>", lang)
				}
			}
			var dep map[string]any
			if err := cl.GetJSON(ctx, deployPath(args[0]), &dep); err != nil {
				return err
			}
			namespace := pick(dep, "namespace")
			if pod == "" {
				var live map[string]any
				if err := cl.GetJSON(ctx, deployPath(args[0], "pods-live"), &live); err != nil {
					return err
				}
				for _, p := range asList(live["pods"]) {
					if strings.EqualFold(pick(p, "status"), "ready") || strings.EqualFold(pick(p, "status"), "running") {
						pod = pick(p, "name")
						break
					}
				}
				if pod == "" {
					return errors.New("no ready pod to open a console in")
				}
			}
			conn, err := cl.DialExec(ctx, pod, namespace, "")
			if err != nil {
				return fmt.Errorf("could not open a session (needs an API token with the 'exec' scope): %w", err)
			}
			// The exec gateway always spawns a shell (inside tmux when the image has
			// it), so replace that shell with the REPL: quitting the REPL ends the
			// pane, and with it the session.
			if err := conn.Write(ctx, websocket.MessageText, []byte("exec "+repl+"\n")); err != nil {
				return err
			}
			output.Warnf("%s in %s", repl, pod)
			return termsession.Run(ctx, conn, os.Stdin, os.Stdout)
		},
	}
	c.Flags().StringVar(&pod, "pod", "", "pod to use (default: the first ready pod)")
	c.Flags().StringVar(&repl, "repl", "", "REPL command to run (default: detected from the app's language)")
	return c
}
