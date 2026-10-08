package cmd

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/hackclub/orchard/cli/internal/output"
)

func sandboxForkCmd() *cobra.Command {
	var name string
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "fork <sandbox>",
		Short: "Fork a machine you own into a new one with the same disk and sessions",
		Long: "Fork copies the machine's home volume (a CSI VolumeSnapshot on Kubernetes, Sandbox.fork on Vercel) " +
			"into a new machine you own, and lists the same worktree sessions on it. " +
			"The server answers 409 when the runner or the disk's storage class cannot be snapshotted.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			body := map[string]any{}
			if name != "" {
				body["name"] = name
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(str(sb["id"]), "fork"), body, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON && !*wait {
				return output.JSON(raw)
			}
			output.Successf("forking %s into %s", pick(sb, "name"), pick(raw, "name"))
			if *wait {
				return runWait(cmd.Context(), cl, sandboxWaitSpec(str(raw["id"]), "running"), *timeout)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "Name of the new machine (defaults to <name>-fork)")
	wait, timeout = addWaitFlags(c)
	return c
}

func sandboxShareCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "share",
		Short: "Read-only share links for org teammates (transcript and diff only)",
	}
	c.AddCommand(sandboxShareCreateCmd(), sandboxShareListCmd(), sandboxShareRevokeCmd())
	return c
}

func sandboxShareCreateCmd() *cobra.Command {
	var session string
	var hours int
	c := &cobra.Command{
		Use:   "create <sandbox>",
		Short: "Create a share link (the token is shown once)",
		Args:  cobra.ExactArgs(1),
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
			body := map[string]any{}
			if session != "" {
				s, err := resolveSandboxSession(cmd.Context(), cl, id, session)
				if err != nil {
					return err
				}
				body["sessionId"] = str(s["id"])
			}
			if hours > 0 {
				body["expiresInHours"] = hours
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(id, "share-links"), body, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("share link %s (expires %s)", pick(raw, "id"), pick(raw, "expiresAt"))
			fmt.Println(str(raw["url"]))
			fmt.Fprintln(os.Stderr, output.Dim("only members of the machine's organization can open it; the link is not shown again"))
			return nil
		},
	}
	c.Flags().StringVar(&session, "session", "", "Share one session (id or slug) instead of every active session")
	c.Flags().IntVar(&hours, "expires-in", 0, "Hours until the link expires (1-720, default 168)")
	return c
}

func shareLinkRows(links []map[string]any) [][]string {
	rows := [][]string{}
	for _, l := range links {
		scope := "all sessions"
		if s, ok := l["session"].(map[string]any); ok {
			scope = pick(s, "title")
		}
		creator := ""
		if u, ok := l["createdBy"].(map[string]any); ok {
			creator = pick(u, "name")
		}
		rows = append(rows, []string{
			pick(l, "id"),
			pick(l, "state"),
			scope,
			pick(l, "expiresAt"),
			pick(l, "lastUsedAt"),
			creator,
		})
	}
	return rows
}

func sandboxShareListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <sandbox>",
		Aliases: []string{"ls"},
		Short:   "List share links and whether they are active, expired or revoked",
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
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), sandboxPath(str(sb["id"]), "share-links"), &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := shareLinkRows(asList(raw["links"]))
			if len(rows) == 0 {
				fmt.Println(output.Dim("no share links"))
				return nil
			}
			output.Table([]string{"id", "state", "scope", "expires", "last used", "created by"}, rows)
			return nil
		},
	}
}

func sandboxShareRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <sandbox> <link-id>",
		Short: "Revoke a share link; viewers lose access on their next request",
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
			var raw map[string]any
			path := sandboxPath(str(sb["id"]), "share-links", args[1])
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("revoked share link %s", pick(raw, "id"))
			return nil
		},
	}
}

func sandboxSessionPromptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "prompt <sandbox> <session> [text|-]",
		Short: "Send a prompt to a session's agent as yourself (reads stdin with - or no text)",
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			text := ""
			if len(args) == 3 && args[2] != "-" {
				text = args[2]
			} else {
				b, err := io.ReadAll(io.LimitReader(os.Stdin, 32769))
				if err != nil {
					return err
				}
				text = string(b)
			}
			if strings.TrimSpace(text) == "" {
				return fmt.Errorf("nothing to send: pass the prompt as an argument or on stdin")
			}
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
			path := sandboxPath(id, "sessions", str(s["id"]), "prompt")
			if err := cl.Send(cmd.Context(), http.MethodPost, path, map[string]any{"text": text}, &raw); err != nil {
				return sandboxDialError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("prompt sent to %s (%s)", pick(s, "slug"), pick(raw, "messageId"))
			return nil
		},
	}
}

func sandboxSessionTranscriptCmd() *cobra.Command {
	var limit int
	c := &cobra.Command{
		Use:   "transcript <sandbox> <session>",
		Short: "Print the latest messages of a session's agent chat",
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
			path := sandboxPath(id, "sessions", str(s["id"]), "transcript")
			if limit > 0 {
				path += "?limit=" + strconv.Itoa(limit)
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return sandboxDialError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			messages := asList(raw["messages"])
			if len(messages) == 0 {
				fmt.Println(output.Dim("no messages yet"))
				return nil
			}
			for _, m := range messages {
				who := "agent"
				if str(m["role"]) == "user" {
					who = "user"
					if u, ok := m["author"].(map[string]any); ok {
						who = pick(u, "name")
					}
				}
				fmt.Println(output.Dim(fmt.Sprintf("── %s · %s", who, pick(m, "createdAt"))))
				fmt.Println(str(m["text"]))
				fmt.Println()
			}
			return nil
		},
	}
	c.Flags().IntVar(&limit, "limit", 0, "How many of the latest messages to show (1-200, default 30)")
	return c
}
