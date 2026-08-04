package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/LeafdTK/leaf/cli/internal/sshproxy"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

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
		sandboxDeleteCmd(),
		sandboxSSHCmd(),
		sandboxProxyCmd(),
		sandboxSSHConfigCmd(),
		sandboxCredentialsCmd(),
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
	for _, s := range items {
		if str(s["name"]) == v {
			return s, nil
		}
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

// sandboxKeyValue resolves one --key value: @file reads the file, a bare
// value that is not a public key but exists on disk is read as a file, and
// anything else is taken literally.
func sandboxKeyValue(v string) (string, error) {
	if path, ok := strings.CutPrefix(v, "@"); ok {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(data)), nil
	}
	if !strings.HasPrefix(v, "ssh-") && !strings.HasPrefix(v, "ecdsa-") {
		if data, err := os.ReadFile(v); err == nil {
			return strings.TrimSpace(string(data)), nil
		}
	}
	return strings.TrimSpace(v), nil
}

func sandboxKeys(values []string) ([]string, error) {
	keys := []string{}
	for _, v := range values {
		key, err := sandboxKeyValue(v)
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, nil
}

// defaultSSHKeys auto-loads the user's public key when create gets no --key.
func defaultSSHKeys() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	for _, name := range []string{"id_ed25519.pub", "id_rsa.pub"} {
		path := filepath.Join(home, ".ssh", name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		key := strings.TrimSpace(string(data))
		if key == "" {
			continue
		}
		output.Warnf("no --key given: using %s", path)
		return []string{key}
	}
	return nil
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
	var keyValues []string
	var setupFile string
	var githubKeys bool
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "create [name]",
		Short: "Create a cloud dev sandbox",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			keys, err := sandboxKeys(keyValues)
			if err != nil {
				return err
			}
			if len(keys) == 0 && !githubKeys {
				keys = defaultSSHKeys()
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if len(args) == 1 {
				body["name"] = args[0]
			}
			if repo != "" {
				body["repoUrl"] = repo
			}
			if len(keys) > 0 {
				body["sshPublicKeys"] = keys
			}
			if githubKeys {
				body["importGithubKeys"] = true
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
				return sandboxFeatureError(err)
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
	c.Flags().StringArrayVar(&keyValues, "key", nil, "ssh public key: literal, @file, or a file path (repeatable; default: ~/.ssh/id_ed25519.pub then id_rsa.pub)")
	c.Flags().BoolVar(&githubKeys, "github-keys", false, "import your public ssh keys from GitHub")
	c.Flags().StringVar(&setupFile, "setup", "", "setup script file run once on first boot (- reads stdin)")
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
			rows := [][]string{}
			for _, s := range items {
				rows = append(rows, []string{
					pick(s, "name"),
					output.Status(pick(s, "status")),
					pick(s, "repoUrl"),
					pick(s, "createdAt"),
					pick(s, "lastActiveAt"),
				})
			}
			output.Table([]string{"name", "status", "repo", "created", "last active"}, rows)
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
			keys, _ := raw["sshPublicKeys"].([]any)
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"status", output.Status(pick(raw, "status"))},
			}
			for _, opt := range [][2]string{
				{"status message", pick(raw, "statusMessage")},
				{"repo", pick(raw, "repoUrl")},
				{"image", pick(raw, "image")},
				{"ssh keys", strconv.Itoa(len(keys))},
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
	var keyValues []string
	var setupFile string
	var noSetup bool
	var githubKeys bool
	c := &cobra.Command{
		Use:   "update <name>",
		Short: "Rename a sandbox or replace its ssh keys",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			if cmd.Flags().Changed("key") {
				keys, err := sandboxKeys(keyValues)
				if err != nil {
					return err
				}
				body["sshPublicKeys"] = keys
			}
			if githubKeys {
				body["importGithubKeys"] = true
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
			if len(body) == 0 {
				return errors.New("nothing to update: pass --name, --key, --github-keys, --setup or --no-setup")
			}
			cl, _, err := client()
			if err != nil {
				return err
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
	c.Flags().StringArrayVar(&keyValues, "key", nil, "ssh public key: literal, @file, or a file path (repeatable; replaces all keys)")
	c.Flags().BoolVar(&githubKeys, "github-keys", false, "import your public ssh keys from GitHub")
	c.Flags().StringVar(&setupFile, "setup", "", "setup script file run once on first boot (- reads stdin)")
	c.Flags().BoolVar(&noSetup, "no-setup", false, "remove the setup script")
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
			sshBin, err := exec.LookPath("ssh")
			if err != nil {
				return fmt.Errorf("no ssh binary on PATH; run `orchard sandbox ssh-config %s` and point your client at ProxyCommand %q", args[0], exe+" sandbox proxy "+id)
			}
			sshArgs := append([]string{
				"-o", "ProxyCommand=" + exe + " sandbox proxy " + id,
				"-o", "StrictHostKeyChecking=accept-new",
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

func sandboxProxyCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "proxy <name>",
		Hidden: true,
		Short:  "Pump raw SSH bytes between stdio and the sandbox tunnel (ProxyCommand)",
		Args:   cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			conn, err := cl.DialSandboxSSH(cmd.Context(), str(sb["id"]))
			if err != nil {
				return sandboxDialError(err)
			}
			return sshproxy.Pipe(cmd.Context(), conn, os.Stdin, os.Stdout)
		},
	}
}

func sandboxSSHConfigCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ssh-config [name]",
		Short: "Print ssh config Host blocks (for ~/.ssh/config and vscode remote-ssh)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
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
				fmt.Println("Host orchard-" + str(sb["name"]))
				fmt.Println("  HostName orchard-sandbox-" + id)
				fmt.Println("  User dev")
				fmt.Println("  ProxyCommand " + exe + " sandbox proxy " + id)
				fmt.Println("  StrictHostKeyChecking accept-new")
			}
			return nil
		},
	}
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
