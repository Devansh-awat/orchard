package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/sshproxy"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var sandboxIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func sandboxCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "sandbox",
		GroupID: groupResources,
		Aliases: []string{"sb"},
		Short:   "Manage isolated cloud dev sandboxes",
	}
	c.AddCommand(
		sandboxCreateCmd(),
		sandboxListCmd(),
		sandboxGetCmd(),
		sandboxUpdateCmd(),
		sandboxStartCmd(),
		sandboxStopCmd(),
		sandboxRetryCmd(),
		sandboxDeleteCmd(),
		sandboxSSHCmd(),
		sandboxChatCmd(),
		sandboxDiffCmd(),
		sandboxRepoCmd(),
		sandboxConversationsCmd(),
		sandboxSessionCmd(),
		sandboxProxyCmd(),
		sandboxSSHConfigCmd(),
		sandboxCredentialsCmd(),
		sandboxBridgeCmd(),
		sandboxForkCmd(),
		sandboxShareCmd(),
		sandboxLinkCmd(),
		sandboxUsageCmd(),
	)
	return c
}

func sandboxPath(id string, rest ...string) string {
	p := "/sandboxes/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

// sandboxFeatureError turns the 404 that gated /sandboxes routes return when
// the feature flag is off into an actionable message.
func sandboxFeatureError(err error) error {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return errors.New("the sandbox feature is not enabled on this server (ask an admin to enable sandbox.enabled)")
	}
	return err
}

func sandboxDialError(err error) error {
	if strings.Contains(err.Error(), "403") {
		return fmt.Errorf("your API token needs the 'exec' scope (orchard auth token create --scope exec): %w", err)
	}
	return sandboxFeatureError(err)
}

func fetchSandboxes(ctx context.Context, cl *api.Client) (map[string]any, error) {
	var raw map[string]any
	if err := cl.GetJSON(ctx, "/sandboxes", &raw); err != nil {
		return nil, sandboxFeatureError(err)
	}
	return raw, nil
}

// resolveSandbox matches exact id, then exact name, then a unique id prefix.
func resolveSandbox(ctx context.Context, cl *api.Client, v string) (map[string]any, error) {
	raw, err := fetchSandboxes(ctx, cl)
	if err != nil {
		return nil, err
	}
	items := asList(raw["sandboxes"])
	for _, s := range items {
		if str(s["id"]) == v {
			return s, nil
		}
	}
	named := []map[string]any{}
	for _, s := range items {
		if str(s["name"]) == v {
			named = append(named, s)
		}
	}
	if len(named) == 1 {
		return named[0], nil
	}
	if len(named) > 1 {
		owned := []map[string]any{}
		for _, s := range named {
			if role := str(s["myRole"]); role == "" || role == "owner" {
				owned = append(owned, s)
			}
		}
		if len(owned) == 1 {
			return owned[0], nil
		}
		labels := make([]string, 0, len(named))
		for _, m := range named {
			labels = append(labels, str(m["name"])+" ("+str(m["id"])+")")
		}
		return nil, fmt.Errorf("sandbox %q is ambiguous between: %s; pass the id", v, strings.Join(labels, ", "))
	}
	matches := []map[string]any{}
	for _, s := range items {
		if strings.HasPrefix(str(s["id"]), v) {
			matches = append(matches, s)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		labels := make([]string, 0, len(matches))
		for _, m := range matches {
			labels = append(labels, str(m["name"])+" ("+str(m["id"])+")")
		}
		return nil, fmt.Errorf("sandbox %q is ambiguous between: %s", v, strings.Join(labels, ", "))
	}
	return nil, fmt.Errorf("sandbox %q not found", v)
}

func sandboxWaitSpec(id, target string) api.WaitSpec {
	return api.WaitSpec{
		Path:    sandboxPath(id),
		Field:   "status",
		Success: []string{target},
		Failure: []string{"error"},
	}
}

// sandboxIdentityName renders a sandbox's attached ssh identity for tables.
func sandboxIdentityName(s map[string]any) string {
	if ident, ok := s["sshIdentity"].(map[string]any); ok {
		if n := str(ident["name"]); n != "" {
			return n
		}
	}
	return "-"
}

// sandboxIdentityError maps the 400 the server returns when the user has no
// ssh identities to register into an actionable message.
func sandboxIdentityError(err error) error {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusBadRequest && strings.Contains(strings.ToLower(apiErr.Message), "identit") {
		return errors.New("you have no ssh identities: add one with `orchard ssh-identity add <name> --key <key>` or `orchard ssh-identity import-github`")
	}
	return sandboxFeatureError(err)
}

func readSetupScript(v string) (string, error) {
	if v == "-" {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", fmt.Errorf("read setup script from stdin: %w", err)
		}
		return string(data), nil
	}
	data, err := os.ReadFile(v)
	if err != nil {
		return "", fmt.Errorf("read setup script: %w", err)
	}
	return string(data), nil
}

func sandboxCreateCmd() *cobra.Command {
	var repo string
	var identity string
	var setupFile string
	var runner string
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "create [name]",
		Short: "Create a cloud dev sandbox",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if len(args) == 1 {
				body["name"] = args[0]
			}
			if runner != "" {
				r := strings.ToLower(strings.TrimSpace(runner))
				if r != "kubernetes" && r != "vercel" {
					return &exitcode.UsageError{Err: fmt.Errorf("--runner must be kubernetes or vercel, got %q", runner)}
				}
				body["runner"] = r
			}
			if repo != "" {
				body["repoUrl"] = repo
			}
			if identity != "" {
				ident, err := resolveSSHIdentity(cmd.Context(), cl, identity)
				if err != nil {
					return err
				}
				body["sshIdentityId"] = str(ident["id"])
			}
			if setupFile != "" {
				script, err := readSetupScript(setupFile)
				if err != nil {
					return err
				}
				body["setupScript"] = script
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/sandboxes", body, &raw); err != nil {
				return sandboxIdentityError(err)
			}
			output.Successf("created sandbox %s (%s)", pick(raw, "name"), str(raw["id"]))
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			}
			if *wait && str(raw["id"]) != "" {
				return runWait(cmd.Context(), cl, sandboxWaitSpec(str(raw["id"]), "running"), *timeout)
			}
			return nil
		},
	}
	c.Flags().StringVar(&repo, "repo", "", "git repository URL to clone into the sandbox")
	c.Flags().StringVar(&identity, "identity", "", "ssh identity name or id (default: your only identity)")
	c.Flags().StringVar(&setupFile, "setup", "", "setup script file run once on first boot (- reads stdin)")
	c.Flags().StringVar(&runner, "runner", "", "where the sandbox runs: kubernetes|vercel (default: the instance default)")
	wait, timeout = addWaitFlags(c)
	return c
}

func sandboxListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List your sandboxes",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			raw, err := fetchSandboxes(cmd.Context(), cl)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			items := asList(raw["sandboxes"])
			showRunner := false
			for _, s := range items {
				if str(s["runner"]) != "" {
					showRunner = true
				}
			}
			rows := [][]string{}
			for _, s := range items {
				row := []string{pick(s, "name"), output.Status(pick(s, "status"))}
				if showRunner {
					row = append(row, orDashStr(pick(s, "runner")))
				}
				rows = append(rows, append(row,
					pick(s, "repoUrl"),
					sandboxIdentityName(s),
					pick(s, "createdAt"),
					pick(s, "lastActiveAt"),
				))
			}
			headers := []string{"name", "status"}
			if showRunner {
				headers = append(headers, "runner")
			}
			output.Table(append(headers, "repo", "identity", "created", "last active"), rows)
			if max := pick(raw, "maxSandboxes"); max != "" {
				fmt.Println(output.Dim(fmt.Sprintf("%d of %s sandboxes used", len(items), max)))
			}
			return nil
		},
	}
}

func sandboxGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <name>",
		Short: "Show a sandbox",
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
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), sandboxPath(str(sb["id"])), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			var identity string
			if ident, ok := raw["sshIdentity"].(map[string]any); ok {
				identity = pick(ident, "name")
			}
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"status", output.Status(pick(raw, "status"))},
			}
			for _, opt := range [][2]string{
				{"status message", pick(raw, "statusMessage")},
				{"runner", pick(raw, "runner")},
				{"repo", pick(raw, "repoUrl")},
				{"image", pick(raw, "image")},
				{"ssh identity", identity},
				{"created", pick(raw, "createdAt")},
				{"last active", pick(raw, "lastActiveAt")},
			} {
				if opt[1] != "" {
					pairs = append(pairs, opt)
				}
			}
			output.KV(pairs)
			return nil
		},
	}
}

func sandboxUpdateCmd() *cobra.Command {
	var name string
	var identity string
	var setupFile string
	var noSetup bool
	c := &cobra.Command{
		Use:   "update <name>",
		Short: "Rename a sandbox or switch its ssh identity",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			if noSetup {
				body["setupScript"] = nil
			} else if setupFile != "" {
				script, err := readSetupScript(setupFile)
				if err != nil {
					return err
				}
				body["setupScript"] = script
			}
			if len(body) == 0 && identity == "" {
				return errors.New("nothing to update: pass --name, --identity, --setup or --no-setup")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if identity != "" {
				ident, err := resolveSSHIdentity(cmd.Context(), cl, identity)
				if err != nil {
					return err
				}
				body["sshIdentityId"] = str(ident["id"])
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, sandboxPath(str(sb["id"])), body, &raw); err != nil {
				return err
			}
			output.Successf("updated sandbox %s", pick(raw, "name"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "new sandbox name")
	c.Flags().StringVar(&identity, "identity", "", "ssh identity name or id to switch to")
	c.Flags().StringVar(&setupFile, "setup", "", "setup script file run once on first boot (- reads stdin)")
	c.Flags().BoolVar(&noSetup, "no-setup", false, "remove the setup script")
	return c
}

func sandboxDiffCmd() *cobra.Command {
	var file string
	var stat bool
	c := &cobra.Command{
		Use:   "diff <name>",
		Short: "Show git changes inside the sandbox workspace",
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
			if stat {
				var raw map[string]any
				if err := cl.GetJSON(cmd.Context(), sandboxPath(id, "changes"), &raw); err != nil {
					return sandboxDialError(err)
				}
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				if b, ok := raw["isRepo"].(bool); ok && !b {
					return errors.New("the sandbox workspace is not a git repository")
				}
				rows := [][]string{}
				for _, f := range asList(raw["files"]) {
					rows = append(rows, []string{
						pick(f, "status"),
						pick(f, "path"),
						pick(f, "additions"),
						pick(f, "deletions"),
					})
				}
				if len(rows) == 0 {
					fmt.Println(output.Dim("working tree clean"))
					return nil
				}
				output.Table([]string{"st", "file", "+", "-"}, rows)
				return nil
			}
			path := sandboxPath(id, "diff")
			if file != "" {
				path += "?file=" + url.QueryEscape(file)
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return sandboxDialError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			fmt.Print(str(raw["diff"]))
			if b, ok := raw["truncated"].(bool); ok && b {
				fmt.Fprintln(os.Stderr, output.Dim("diff truncated"))
			}
			return nil
		},
	}
	c.Flags().StringVar(&file, "file", "", "limit the diff to one file")
	c.Flags().BoolVar(&stat, "stat", false, "list changed files instead of the diff")
	return c
}

func sandboxRepoCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "repo",
		Short: "Manage git repositories inside a sandbox",
	}
	c.AddCommand(sandboxRepoListCmd(), sandboxRepoAddCmd(), sandboxRepoIconCmd())
	return c
}

func sandboxRepoListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <sandbox>",
		Aliases: []string{"ls"},
		Short:   "List repositories cloned into a sandbox",
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
			if err := cl.GetJSON(cmd.Context(), sandboxPath(str(sb["id"]), "repos"), &raw); err != nil {
				return sandboxDialError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, r := range asList(raw["repos"]) {
				github := ""
				if gh, ok := r["github"].(map[string]any); ok {
					github = str(gh["owner"]) + "/" + str(gh["name"])
				}
				rows = append(rows, []string{pick(r, "name"), pick(r, "branch"), pick(r, "dirtyFiles"), github, pick(r, "icon")})
			}
			if len(rows) == 0 {
				fmt.Println(output.Dim("no repositories cloned yet"))
				return nil
			}
			output.Table([]string{"name", "branch", "dirty", "github", "icon"}, rows)
			return nil
		},
	}
}

func sandboxRepoAddCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add <sandbox> <repo-url>",
		Short: "Clone another repository into a sandbox",
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
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(str(sb["id"]), "repos"), map[string]any{"repoUrl": args[1]}, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			output.Successf("cloning %s in the background (see ~/.clone.log in the sandbox)", pick(raw, "name"))
			return nil
		},
	}
}

func sandboxRepoIconCmd() *cobra.Command {
	var clear bool
	c := &cobra.Command{
		Use:   "icon <sandbox> <repo> [icon]",
		Short: "Set the icon a repository shows in Greenhouse",
		Long: "Set the icon a repository shows in Greenhouse, for everyone on the machine.\n" +
			"The icon is one emoji, \"github\" for the owner's avatar, or lucide:<name>\n" +
			"(rocket, globe, server, database, package, terminal, code, book, leaf, sprout,\n" +
			"flame, zap, cpu, cloud, shield, palette, gamepad-2, bot, music, camera).\n" +
			"Pass --clear to go back to the initial letter.",
		Args: cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			if clear == (len(args) == 3) {
				return &exitcode.UsageError{Err: errors.New("pass either an icon or --clear")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			var icon any
			if !clear {
				icon = args[2]
			}
			var raw map[string]any
			path := sandboxPath(str(sb["id"]), "repos", url.PathEscape(args[1]), "icon")
			if err := cl.Send(cmd.Context(), http.MethodPut, path, map[string]any{"icon": icon}, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			if raw["icon"] == nil {
				output.Successf("cleared the icon of %s", pick(raw, "name"))
			} else {
				output.Successf("%s now shows %s", pick(raw, "name"), pick(raw, "icon"))
			}
			return nil
		},
	}
	c.Flags().BoolVar(&clear, "clear", false, "remove the icon")
	return c
}

func sandboxConversationsCmd() *cobra.Command {
	var history string
	var newTitle string
	var rename string
	var remove string
	c := &cobra.Command{
		Use:     "conversations <sandbox>",
		Aliases: []string{"convos"},
		Short:   "List and manage Cloud Code conversations in a sandbox",
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
			id := str(sb["id"])
			if newTitle != "" {
				var raw map[string]any
				if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(id, "conversations"), map[string]any{"title": newTitle}, &raw); err != nil {
					return sandboxFeatureError(err)
				}
				output.Successf("created conversation %s (%s)", pick(raw, "title"), str(raw["id"]))
				return nil
			}
			if rename != "" {
				parts := strings.SplitN(rename, "=", 2)
				if len(parts) != 2 {
					return errors.New("--rename takes <conversation-id>=<new title>")
				}
				var raw map[string]any
				if err := cl.Send(cmd.Context(), http.MethodPatch, sandboxPath(id, "conversations", parts[0]), map[string]any{"title": parts[1]}, &raw); err != nil {
					return sandboxFeatureError(err)
				}
				output.Successf("renamed conversation to %s", pick(raw, "title"))
				return nil
			}
			if remove != "" {
				var raw map[string]any
				if err := cl.Send(cmd.Context(), http.MethodDelete, sandboxPath(id, "conversations", remove), nil, &raw); err != nil {
					return sandboxFeatureError(err)
				}
				output.Successf("deleted conversation %s", remove)
				return nil
			}
			if history != "" {
				var raw map[string]any
				if err := cl.GetJSON(cmd.Context(), sandboxPath(id, "conversations", history, "history"), &raw); err != nil {
					return sandboxDialError(err)
				}
				return output.JSON(raw)
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), sandboxPath(id, "conversations"), &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, cv := range asList(raw["conversations"]) {
				rows = append(rows, []string{str(cv["id"]), pick(cv, "title"), pick(cv, "repo"), pick(cv, "updatedAt")})
			}
			if len(rows) == 0 {
				fmt.Println(output.Dim("no conversations yet"))
				return nil
			}
			output.Table([]string{"id", "title", "repo", "updated"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&history, "history", "", "print a conversation transcript as json by conversation id")
	c.Flags().StringVar(&newTitle, "new", "", "create a conversation with this title")
	c.Flags().StringVar(&rename, "rename", "", "rename: <conversation-id>=<new title>")
	c.Flags().StringVar(&remove, "delete", "", "delete a conversation by id")
	return c
}

func sandboxStartCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "start <name>",
		Short: "Start a stopped sandbox",
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
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(id, "start"), nil, nil); err != nil {
				return err
			}
			output.Successf("starting sandbox %s", pick(sb, "name"))
			if *wait {
				return runWait(cmd.Context(), cl, sandboxWaitSpec(id, "running"), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func sandboxStopCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "stop <name>",
		Short: "Stop a sandbox (its home volume is kept)",
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
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(id, "stop"), nil, nil); err != nil {
				return err
			}
			output.Successf("stopping sandbox %s", pick(sb, "name"))
			if *wait {
				return runWait(cmd.Context(), cl, sandboxWaitSpec(id, "stopped"), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func sandboxRetryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "retry <name>",
		Short: "Retry a sandbox's failed cluster or Vercel changes",
		Long: "Requeue every failed apply for a sandbox (the error shown as applyError on\n" +
			"`orchard sandbox get`) so it runs again now with fresh retries. Host or org admin.",
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
			var res struct {
				Retried int `json:"retried"`
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(str(sb["id"]), "apply", "retry"), nil, &res); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(map[string]any{"retried": res.Retried})
			}
			if res.Retried == 0 {
				output.Successf("nothing to retry for sandbox %s", pick(sb, "name"))
				return nil
			}
			output.Successf("retrying %d failed change(s) for sandbox %s", res.Retried, pick(sb, "name"))
			return nil
		},
	}
}

func sandboxDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <name>",
		Aliases: []string{"rm"},
		Short:   "Delete a sandbox and its home volume",
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
			if err := output.Confirm(fmt.Sprintf("permanently delete sandbox %s and its home volume", pick(sb, "name")), yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, sandboxPath(str(sb["id"])), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted sandbox %s", pick(sb, "name"))
			return nil
		},
	}
}

// ensureSandboxRunning starts a stopped sandbox (with --start or an
// interactive confirmation) and waits until it is reachable.
func ensureSandboxRunning(ctx context.Context, cl *api.Client, sb map[string]any, startFlag bool, timeout time.Duration) error {
	name, id := str(sb["name"]), str(sb["id"])
	switch str(sb["status"]) {
	case "running":
		return nil
	case "creating", "starting":
	case "stopped", "stopping":
		if !startFlag {
			if !term.IsTerminal(int(os.Stdin.Fd())) {
				return fmt.Errorf("sandbox is stopped; run 'orchard sandbox start %s' or pass --start", name)
			}
			fmt.Fprintf(os.Stderr, "sandbox %s is stopped; start it now? [y/N] ", name)
			var line string
			_, _ = fmt.Fscanln(os.Stdin, &line)
			switch strings.ToLower(strings.TrimSpace(line)) {
			case "y", "yes":
			default:
				return fmt.Errorf("sandbox is stopped; run 'orchard sandbox start %s' or pass --start", name)
			}
		}
		if err := cl.Send(ctx, http.MethodPost, sandboxPath(id, "start"), nil, nil); err != nil {
			return err
		}
	default:
		return fmt.Errorf("sandbox %s is %s", name, str(sb["status"]))
	}
	return runWait(ctx, cl, sandboxWaitSpec(id, "running"), timeout)
}

func sandboxSSHCmd() *cobra.Command {
	var start bool
	var user string
	c := &cobra.Command{
		Use:   "ssh <name> [-- ssh-args...]",
		Short: "SSH into a sandbox through the orchard tunnel",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			extra := []string{}
			if d := cmd.ArgsLenAtDash(); d != -1 {
				if d != 1 {
					return errors.New("usage: orchard sandbox ssh <name> [-- ssh-args...]")
				}
				extra = args[1:]
			} else if len(args) > 1 {
				return errors.New("usage: orchard sandbox ssh <name> [-- ssh-args...]")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if err := ensureSandboxRunning(cmd.Context(), cl, sb, start, 10*time.Minute); err != nil {
				return err
			}
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			id := str(sb["id"])
			if !sandboxIDPattern.MatchString(id) {
				return fmt.Errorf("refusing to use sandbox id %q in an ssh ProxyCommand", id)
			}
			sshBin, err := exec.LookPath("ssh")
			if err != nil {
				return fmt.Errorf("no ssh binary on PATH; run `orchard sandbox ssh-config %s` and point your client at ProxyCommand %q", args[0], exe+" sandbox proxy "+id)
			}
			alias := sshHostKeyAlias("orchard-" + str(sb["name"]))
			knownHosts, kerr := refreshSandboxKnownHosts(cmd.Context(), cl, id, alias)
			if kerr != nil && !hostKeysUnsupported(kerr) {
				fmt.Fprintf(os.Stderr, "orchard: could not refresh host keys in %s: %v\n", knownHosts, kerr)
			}
			sshArgs := append([]string{
				"-o", "ProxyCommand=" + exe + " sandbox proxy " + id,
				"-o", "StrictHostKeyChecking=accept-new",
				"-o", "HostKeyAlias=" + alias,
				"-o", "UserKnownHostsFile=" + knownHosts,
				user + "@orchard-sandbox-" + str(sb["name"]),
			}, extra...)
			run := exec.CommandContext(cmd.Context(), sshBin, sshArgs...)
			run.Stdin, run.Stdout, run.Stderr = os.Stdin, os.Stdout, os.Stderr
			return run.Run()
		},
	}
	c.Flags().BoolVar(&start, "start", false, "start the sandbox first if it is stopped")
	c.Flags().StringVar(&user, "user", "dev", "ssh user")
	return c
}

// sandboxChatEvent covers the stream-json shapes the chat stream can carry.
type sandboxChatEvent struct {
	Type    string `json:"type"`
	Detail  string `json:"detail"`
	Text    string `json:"text"`
	Message struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Name string `json:"name"`
		} `json:"content"`
	} `json:"message"`
}

func sandboxChatCmd() *cobra.Command {
	var message string
	c := &cobra.Command{
		Use:   "chat <name> [message...]",
		Short: "Send a message to the claude agent in a sandbox",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			msg := strings.Join(args[1:], " ")
			if cmd.Flags().Changed("message") {
				msg = message
			}
			if msg == "" && !term.IsTerminal(int(os.Stdin.Fd())) {
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					return err
				}
				msg = strings.TrimSpace(string(data))
			}
			if msg == "" {
				return errors.New("no message: pass it as arguments, with -m, or on stdin")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			events, errs := cl.StreamChat(cmd.Context(), sandboxPath(str(sb["id"]), "chat"), map[string]any{"message": msg})
			needNewline := false
			for raw := range events {
				var ev sandboxChatEvent
				if json.Unmarshal(raw, &ev) != nil {
					continue
				}
				switch ev.Type {
				case "assistant":
					for _, block := range ev.Message.Content {
						switch block.Type {
						case "text":
							fmt.Print(block.Text)
							needNewline = !strings.HasSuffix(block.Text, "\n")
						case "tool_use":
							fmt.Fprintf(os.Stderr, "[tool] %s\n", block.Name)
						}
					}
				case "result":
					if fmtFlag() == output.FormatJSON {
						if needNewline {
							fmt.Println()
							needNewline = false
						}
						fmt.Println(string(raw))
					}
				case "error":
					if needNewline {
						fmt.Println()
					}
					return errors.New(ev.Detail)
				case "raw":
					fmt.Fprint(os.Stderr, ev.Text)
				}
			}
			if needNewline {
				fmt.Println()
			}
			if err := <-errs; err != nil {
				return sandboxDialError(err)
			}
			return nil
		},
	}
	c.Flags().StringVarP(&message, "message", "m", "", "message to send (default: the remaining args, or stdin)")
	return c
}

func sandboxNameFromSSHHost(host string) string {
	host = strings.TrimSpace(host)
	if i := strings.LastIndex(host, "@"); i >= 0 {
		host = host[i+1:]
	}
	return strings.TrimPrefix(host, "orchard-")
}

func sshHostKeyAlias(host string) string {
	host = strings.TrimSpace(host)
	if i := strings.LastIndex(host, "@"); i >= 0 {
		host = host[i+1:]
	}
	return strings.ToLower(host)
}

func sandboxProxyCmd() *cobra.Command {
	var host string
	c := &cobra.Command{
		Use:    "proxy [name]",
		Hidden: true,
		Short:  "Pump raw SSH bytes between stdio and the sandbox tunnel (ProxyCommand)",
		Args:   cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			switch {
			case host != "" && len(args) == 1:
				return &exitcode.UsageError{Err: errors.New("pass either a sandbox name or --host, not both")}
			case host != "":
				target = sandboxNameFromSSHHost(host)
			case len(args) == 1:
				target = args[0]
			}
			if target == "" {
				return &exitcode.UsageError{Err: errors.New("usage: orchard sandbox proxy <name> | --host orchard-<name>")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, target)
			if err != nil {
				return err
			}
			if host != "" {
				if path, kerr := refreshSandboxKnownHosts(cmd.Context(), cl, str(sb["id"]), sshHostKeyAlias(host)); kerr != nil && !hostKeysUnsupported(kerr) {
					fmt.Fprintf(os.Stderr, "orchard: could not refresh host keys in %s: %v\n", path, kerr)
				}
			}
			conn, err := cl.DialSandboxSSH(cmd.Context(), str(sb["id"]))
			if err != nil {
				return sandboxDialError(err)
			}
			return sshproxy.Pipe(cmd.Context(), conn, os.Stdin, os.Stdout)
		},
	}
	c.Flags().StringVar(&host, "host", "", "ssh host alias (orchard-<name>, as passed by ssh's %n)")
	return c
}

func sandboxBridgeCmd() *cobra.Command {
	var listen, target, tokenFile string
	c := &cobra.Command{
		Use:    "bridge",
		Hidden: true,
		Short:  "Serve a token-gated websocket that tunnels to a local tcp port (runs inside a sandbox)",
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if tokenFile == "" {
				return &exitcode.UsageError{Err: errors.New("--token-file is required")}
			}
			if _, err := os.Stat(tokenFile); err != nil {
				fmt.Fprintf(os.Stderr, "bridge: token file not readable yet (%v); rejecting tunnels until it is\n", err)
			}
			b := &sshproxy.Bridge{
				Target:    target,
				TokenFile: tokenFile,
				Logf: func(format string, a ...any) {
					fmt.Fprintf(os.Stderr, format+"\n", a...)
				},
			}
			fmt.Fprintf(os.Stderr, "bridge: listening on %s, tunnelling to %s\n", listen, target)
			return b.ListenAndServe(cmd.Context(), listen)
		},
	}
	c.Flags().StringVar(&listen, "listen", "0.0.0.0:2222", "address to accept websocket tunnels on")
	c.Flags().StringVar(&target, "target", "127.0.0.1:22", "tcp address each tunnel connects to")
	c.Flags().StringVar(&tokenFile, "token-file", "", "file holding the bearer token (re-read on every connection)")
	return c
}

func sandboxSSHConfigCmd() *cobra.Command {
	var install bool
	c := &cobra.Command{
		Use:   "ssh-config [name]",
		Short: "Print ssh config Host blocks, or --install a wildcard orchard-* entry into ~/.ssh/config",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if install && len(args) > 0 {
				return &exitcode.UsageError{Err: errors.New("--install covers every sandbox; drop the name")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if install {
				res, err := installOrchardSSH(cmd.Context(), cl)
				if err != nil {
					return err
				}
				return printSSHInstallResult(res)
			}
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			var items []map[string]any
			if len(args) == 1 {
				sb, rerr := resolveSandbox(cmd.Context(), cl, args[0])
				if rerr != nil {
					return rerr
				}
				items = []map[string]any{sb}
			} else {
				raw, rerr := fetchSandboxes(cmd.Context(), cl)
				if rerr != nil {
					return rerr
				}
				items = asList(raw["sandboxes"])
			}
			for i, sb := range items {
				if i > 0 {
					fmt.Println()
				}
				id := str(sb["id"])
				if !sandboxIDPattern.MatchString(id) {
					return fmt.Errorf("refusing to write sandbox id %q into an ssh config", id)
				}
				fmt.Println("Host orchard-" + str(sb["name"]))
				fmt.Println("  HostName orchard-sandbox-" + id)
				fmt.Println("  User dev")
				fmt.Println("  ProxyCommand " + exe + " sandbox proxy " + id)
				fmt.Println("  StrictHostKeyChecking accept-new")
			}
			return nil
		},
	}
	c.Flags().BoolVar(&install, "install", false, "generate an orchard ssh key, register it, and wire `ssh orchard-<name>` into ~/.ssh/config")
	return c
}

func sandboxCredentialsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "credentials",
		Short: "Manage agent tokens injected into your sandboxes",
	}
	c.AddCommand(
		sandboxCredentialsSetCmd(),
		sandboxCredentialsClearCmd(),
		sandboxCredentialsStatusCmd(),
	)
	return c
}

// credentialValue resolves a token flag; "-" reads the token from stdin so it
// stays out of shell history.
func credentialValue(v string, stdinUsed *bool) (string, error) {
	if v != "-" {
		return v, nil
	}
	if *stdinUsed {
		return "", errors.New("only one token can be read from stdin")
	}
	*stdinUsed = true
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", errors.New("empty token on stdin")
	}
	return token, nil
}

func sandboxCredentialsSetCmd() *cobra.Command {
	var claude, openai string
	c := &cobra.Command{
		Use:   "set",
		Short: "Store agent tokens (claude code / openai) for your sandboxes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			var stdinUsed bool
			if cmd.Flags().Changed("claude") {
				v, err := credentialValue(claude, &stdinUsed)
				if err != nil {
					return err
				}
				body["claudeToken"] = v
			}
			if cmd.Flags().Changed("openai") {
				v, err := credentialValue(openai, &stdinUsed)
				if err != nil {
					return err
				}
				body["openaiToken"] = v
			}
			if len(body) == 0 {
				return errors.New("nothing to set: pass --claude and/or --openai (use - to read the token from stdin)")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPut, "/sandboxes/credentials", body, nil); err != nil {
				return sandboxFeatureError(err)
			}
			output.Successf("stored sandbox credentials")
			return nil
		},
	}
	c.Flags().StringVar(&claude, "claude", "", "claude code oauth token from `claude setup-token` (- reads stdin)")
	c.Flags().StringVar(&openai, "openai", "", "openai/codex token (- reads stdin)")
	return c
}

func sandboxCredentialsClearCmd() *cobra.Command {
	var claude, openai bool
	c := &cobra.Command{
		Use:   "clear",
		Short: "Remove stored sandbox agent tokens",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if claude {
				body["claudeToken"] = nil
			}
			if openai {
				body["openaiToken"] = nil
			}
			if len(body) == 0 {
				return errors.New("nothing to clear: pass --claude and/or --openai")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPut, "/sandboxes/credentials", body, nil); err != nil {
				return sandboxFeatureError(err)
			}
			output.Successf("cleared sandbox credentials")
			return nil
		},
	}
	c.Flags().BoolVar(&claude, "claude", false, "clear the claude token")
	c.Flags().BoolVar(&openai, "openai", false, "clear the openai token")
	return c
}

func sandboxCredentialsStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show which sandbox agent tokens are configured (never the values)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/sandboxes/credentials", &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"claude", credentialState(raw["claude"])},
				{"openai", credentialState(raw["openai"])},
			})
			return nil
		},
	}
}

func credentialState(v any) string {
	if b, _ := v.(bool); b {
		return "configured"
	}
	return output.Dim("not configured")
}
