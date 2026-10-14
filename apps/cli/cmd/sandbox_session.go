package cmd

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
)

func sandboxSessionCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "session",
		Aliases: []string{"sessions"},
		Short:   "Manage worktree agent sessions inside a sandbox",
	}
	c.AddCommand(
		sandboxSessionListCmd(),
		sandboxSessionCreateCmd(),
		sandboxSessionArchiveCmd(),
		sandboxSessionPromptCmd(),
		sandboxSessionTranscriptCmd(),
		sandboxSessionPreviewCmd(),
	)
	return c
}

func sessionDiffstat(s map[string]any) string {
	d, ok := s["diffstat"].(map[string]any)
	if !ok {
		return ""
	}
	return fmt.Sprintf("+%s -%s", pick(d, "additions"), pick(d, "deletions"))
}

func resolveSandboxSession(ctx context.Context, cl *api.Client, sandboxID, v string) (map[string]any, error) {
	var raw map[string]any
	if err := cl.GetJSON(ctx, sandboxPath(sandboxID, "sessions")+"?includeArchived=1", &raw); err != nil {
		return nil, sandboxFeatureError(err)
	}
	var prefix []map[string]any
	for _, s := range asList(raw["sessions"]) {
		if str(s["id"]) == v || str(s["slug"]) == v {
			return s, nil
		}
		if strings.HasPrefix(str(s["id"]), v) || strings.HasPrefix(str(s["slug"]), v) {
			prefix = append(prefix, s)
		}
	}
	if len(prefix) == 1 {
		return prefix[0], nil
	}
	if len(prefix) > 1 {
		return nil, fmt.Errorf("%q matches more than one session; use the full id or slug", v)
	}
	return nil, fmt.Errorf("no session %q in this sandbox", v)
}

func sandboxSessionListCmd() *cobra.Command {
	var all bool
	c := &cobra.Command{
		Use:     "list <sandbox>",
		Aliases: []string{"ls"},
		Short:   "List sessions with their branch, diffstat and PR",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			path := sandboxPath(str(sb["id"]), "sessions")
			if all {
				path += "?includeArchived=1"
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, s := range asList(raw["sessions"]) {
				rows = append(rows, []string{
					pick(s, "slug"),
					pick(s, "title"),
					pick(s, "repo"),
					pick(s, "branch"),
					sessionDiffstat(s),
					pick(s, "activity"),
					pick(s, "status"),
					pick(s, "prUrl"),
				})
			}
			if len(rows) == 0 {
				fmt.Println(output.Dim("no sessions yet"))
				return nil
			}
			output.Table([]string{"slug", "title", "repo", "branch", "diff", "activity", "status", "pr"}, rows)
			return nil
		},
	}
	c.Flags().BoolVar(&all, "all", false, "Include archived sessions")
	return c
}

func sandboxSessionCreateCmd() *cobra.Command {
	var base, title, prompt, agent string
	c := &cobra.Command{
		Use:   "create <sandbox> <repo>",
		Short: "Start a session on a fresh git worktree (branch orchard/<slug>)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			body := map[string]any{"repo": args[1]}
			if base != "" {
				body["baseBranch"] = base
			}
			if title != "" {
				body["title"] = title
			}
			if prompt != "" {
				body["prompt"] = prompt
			}
			if agent != "" {
				body["agent"] = agent
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(str(sb["id"]), "sessions"), body, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("session %s on %s (worktree %s)", pick(raw, "slug"), pick(raw, "branch"), pick(raw, "worktreePath"))
			return nil
		},
	}
	c.Flags().StringVar(&base, "base", "", "Base branch (defaults to the repo's default branch)")
	c.Flags().StringVar(&title, "title", "", "Session title")
	c.Flags().StringVar(&prompt, "prompt", "", "First prompt for the agent")
	c.Flags().StringVar(&agent, "agent", "", "Coding agent: opencode (default), acp:claude, acp:opencode, acp:fx or acp:codex")
	return c
}

func sandboxSessionArchiveCmd() *cobra.Command {
	var restore bool
	c := &cobra.Command{
		Use:   "archive <sandbox> <session>",
		Short: "Archive a session (removes the worktree, keeps the branch)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			id := str(sb["id"])
			s, err := resolveSandboxSession(cmd.Context(), cl, id, args[1])
			if err != nil {
				return err
			}
			var raw map[string]any
			path := sandboxPath(id, "sessions", str(s["id"]))
			if err := cl.Send(cmd.Context(), http.MethodPatch, path, map[string]any{"archived": !restore}, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			if restore {
				output.Successf("restored session %s", pick(raw, "slug"))
			} else {
				output.Successf("archived session %s (branch %s kept)", pick(raw, "slug"), pick(raw, "branch"))
			}
			return nil
		},
	}
	c.Flags().BoolVar(&restore, "restore", false, "Restore an archived session instead")
	return c
}
