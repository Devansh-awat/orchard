package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func authCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "auth",
		GroupID: groupCore,
		Short:   "Manage authentication",
	}
	c.AddCommand(authLoginCmd(), authStatusCmd(), authLogoutCmd(), authTokenCmd(), authSessionCmd())
	return c
}

func authLoginCmd() *cobra.Command {
	var token, apiURL, webURL string
	var noBrowser, withToken bool
	c := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with Orchard",
		Long: "Sign in through your browser (default). Orchard creates a personal API token\n" + "and sends it back over a local callback.\n\n" +
			"Or paste a token with --token (create one in Account settings, under API\n" + "tokens), or set ORCHARD_API_TOKEN.",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, _ := config.Load()
			if apiURL != "" {
				cfg.APIURL = apiURL
			}

			// Manual token path: explicit --token, --with-token prompt, or a
			// non-interactive stdin (pipe). --no-browser only needs the URL
			// printed, so it stays on the browser path without a terminal.
			if token != "" || withToken || (!output.IsTTY() && !noBrowser) {
				if token == "" {
					if output.StdinIsTTY() {
						output.Fprint(os.Stderr, "Paste your Orchard API token (orch_…): ")
					}
					r := bufio.NewReader(os.Stdin)
					line, _ := r.ReadString('\n')
					token = strings.TrimSpace(line)
				}
				if token == "" {
					return errors.New("no token provided: pass --token, pipe one on stdin, or use --no-browser --api-url <url> to sign in through a link")
				}
				if !strings.HasPrefix(token, "orch_") {
					output.Warnf("token doesn't start with orch_, continuing anyway")
				}
				cfg.Token = token
				cl := api.New(cfg.APIURL, cfg.Token)
				var me map[string]any
				if err := cl.GetJSON(cmd.Context(), "/auth/me", &me); err != nil {
					return fmt.Errorf("token rejected by %s: %w", cfg.APIURL, err)
				}
				if err := cfg.Save(); err != nil {
					return err
				}
				output.Successf("signed in to %s as %s", cfg.APIURL, displayUser(me))
				return nil
			}

			// Browser flow. The web app is served from the same origin as the
			// API unless overridden.
			base := webURL
			if base == "" {
				if apiURL != "" {
					base = apiURL
				} else if noBrowser && !output.StdinIsTTY() {
					savedBase, baseErr := headlessLoginBaseURL(cfg.APIURL)
					if baseErr != nil {
						return baseErr
					}
					base = savedBase
				} else {
					selectedBase, promptErr := chooseLoginBaseURL(os.Stdin, os.Stderr)
					if promptErr != nil {
						return promptErr
					}
					base = selectedBase
					cfg.APIURL = base
				}
			}
			return webLogin(cfg, base, !noBrowser)
		},
	}
	c.Flags().StringVar(&token, "token", "", "paste a token instead of using the browser")
	c.Flags().BoolVar(&withToken, "with-token", false, "prompt for a token instead of using the browser")
	c.Flags().StringVar(&apiURL, "api-url", "", "override API base URL")
	c.Flags().StringVar(&webURL, "web-url", "", "override web app base URL (defaults to the API URL)")
	c.Flags().BoolVar(&noBrowser, "no-browser", false, "print the URL instead of opening a browser")
	return c
}

// headlessLoginBaseURL picks the instance when there is nobody to ask. Falling
// back to the default would send a self-hoster to the wrong Orchard.
func headlessLoginBaseURL(saved string) (string, error) {
	if saved == "" || saved == config.DefaultAPIURL {
		return "", errors.New("--no-browser without a terminal needs to know which Orchard to use: pass --api-url <url>")
	}
	return saved, nil
}

func chooseLoginBaseURL(in io.Reader, out io.Writer) (string, error) {
	r := bufio.NewReader(in)
	fmt.Fprintln(out, "Where do you want to sign in?")
	fmt.Fprintln(out, "1) Hack Club Orchard")
	fmt.Fprintln(out, "2) Self-hosted Orchard")
	fmt.Fprint(out, "Choose an Orchard instance [1]: ")
	choice, err := r.ReadString('\n')
	if err != nil && len(choice) == 0 {
		return "", fmt.Errorf("couldn't read Orchard instance choice: %w", err)
	}
	choice = strings.TrimSpace(choice)
	if choice == "" || choice == "1" {
		return config.DefaultAPIURL, nil
	}
	if choice != "2" {
		return "", fmt.Errorf("invalid Orchard instance choice %q: choose 1 or 2", choice)
	}

	fmt.Fprint(out, "Base URL: ")
	base, err := r.ReadString('\n')
	if err != nil && len(base) == 0 {
		return "", fmt.Errorf("couldn't read self-hosted base URL: %w", err)
	}
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("invalid self-hosted base URL %q: use an http:// or https:// URL", base)
	}
	return base, nil
}

func authStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the current authentication state",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			var me map[string]any
			if err := cl.GetJSON(cmd.Context(), "/auth/me", &me); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(me)
			}
			output.Successf("authenticated to %s", cfg.APIURL)
			output.Println(output.Dim("user: ") + displayUser(me))
			return nil
		},
	}
}

func authLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove the stored token",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, _ := config.Load()
			cfg.Token = ""
			if err := cfg.Save(); err != nil {
				return err
			}
			output.Successf("logged out")
			return nil
		},
	}
}

func authTokenCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "token",
		Aliases: []string{"tokens"},
		Short:   "Manage personal API tokens (orch_…)",
	}
	c.AddCommand(authTokenListCmd(), authTokenCreateCmd(), authTokenRevokeCmd())
	return c
}

// authJoin renders a JSON string array (scopes, restrictedProjectIds) as a
// comma-separated cell.
func authJoin(v any) string {
	arr, ok := v.([]any)
	if !ok {
		return ""
	}
	parts := []string{}
	for _, e := range arr {
		if s, ok := e.(string); ok && s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, ",")
}

func authTokenListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List your API tokens (secrets are never shown)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/auth/tokens", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, t := range asList(raw) {
				projects := authJoin(t["restrictedProjectIds"])
				if projects == "" {
					projects = output.Dim("(all)")
				}
				rows = append(rows, []string{
					pick(t, "id"),
					pick(t, "name"),
					authJoin(t["scopes"]),
					projects,
					pick(t, "lastUsedAt"),
					pick(t, "expiresAt"),
				})
			}
			output.Table([]string{"id", "name", "scopes", "projects", "last used", "expires"}, rows)
			return nil
		},
	}
}

// authMaxTokenLifetime mirrors the server's hard cap on token lifetime.
const authMaxTokenLifetime = 90 * 24 * time.Hour

// authParseExpiresIn accepts a day suffix ("30d") plus plain Go durations
// ("12h", "45m").
func authParseExpiresIn(s string) (time.Duration, error) {
	if days, ok := strings.CutSuffix(s, "d"); ok {
		n, err := strconv.Atoi(days)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("invalid --expires-in %q: expected a positive day count like 30d", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("invalid --expires-in %q: use 30d, 12h, 45m", s)
	}
	return d, nil
}

func authTokenCreateCmd() *cobra.Command {
	var name, expiresIn string
	var scopes, projects []string
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a personal API token (the secret is shown only once)",
		Long: "Create a personal API token (orch_…) for scripts, CI, and this CLI.\n\n" +
			"Tokens last at most 90 days (the server caps longer --expires-in values)\n" +
			"and default to the read scope; repeat --scope for deploy/exec. Restrict a\n" +
			"token to specific projects with repeated --project flags (id or slug);\n" +
			"omit --project for a token that reaches everything you can.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			for _, s := range scopes {
				switch s {
				case "read", "deploy", "exec":
				default:
					return fmt.Errorf("invalid --scope %q: valid scopes are read, deploy, exec", s)
				}
			}
			body := map[string]any{"name": name}
			if len(scopes) > 0 {
				body["scopes"] = scopes
			}
			if expiresIn != "" {
				d, err := authParseExpiresIn(expiresIn)
				if err != nil {
					return err
				}
				if d > authMaxTokenLifetime {
					output.Warnf("tokens last at most 90 days, so the server caps this one")
				}
				body["expiresAt"] = time.Now().Add(d).UTC().Format(time.RFC3339)
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if len(projects) > 0 {
				ids := []string{}
				for _, p := range projects {
					m, rerr := resolveProject(cmd.Context(), cl, p)
					if rerr != nil {
						return rerr
					}
					ids = append(ids, str(m["id"]))
				}
				body["restrictedProjectIds"] = ids
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/auth/tokens", body, &raw); err != nil {
				return err
			}
			output.Successf("created token %s (%s)", pick(raw, "name"), pick(raw, "id"))
			output.Warnf("the token is shown only once, so store it now")
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"token", pick(raw, "token")},
				{"scopes", authJoin(raw["scopes"])},
			}
			if p := authJoin(raw["restrictedProjectIds"]); p != "" {
				pairs = append(pairs, [2]string{"projects", p})
			}
			pairs = append(pairs, [2]string{"expires", pick(raw, "expiresAt")})
			output.KV(pairs)
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "token name (required)")
	c.Flags().StringArrayVar(&scopes, "scope", nil, "token scope: read|deploy|exec (repeatable; default read)")
	c.Flags().StringArrayVar(&projects, "project", nil, "restrict the token to a project id or slug (repeatable)")
	c.Flags().StringVar(&expiresIn, "expires-in", "", "lifetime like 30d or 12h (default and max 90d)")
	_ = c.MarkFlagRequired("name")
	return c
}

func authTokenRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "revoke <tokenId>",
		Aliases: []string{"delete", "rm"},
		Short:   "Revoke an API token",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("revoke API token %s (anything using it stops working immediately)", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/auth/tokens/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("revoked token %s", args[0])
			return nil
		},
	}
}

func authSessionCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "session",
		Aliases: []string{"sessions"},
		Short:   "Manage browser sign-in sessions",
	}
	c.AddCommand(authSessionListCmd(), authSessionRevokeCmd(), authSessionRevokeAllCmd())
	return c
}

func authSessionListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List active browser sessions",
		Long: "List active browser sessions. The current column marks the session that\n" +
			"made this request; the CLI authenticates with an API token rather than a\n" +
			"session, so normally no row is marked.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/auth/sessions", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, s := range asList(raw["sessions"]) {
				cur := ""
				if b, _ := s["isCurrent"].(bool); b {
					cur = "✓"
				}
				rows = append(rows, []string{
					pick(s, "id"),
					pick(s, "deviceName"),
					pick(s, "location"),
					pick(s, "ipAddress"),
					pick(s, "authMethod"),
					pick(s, "lastActiveAt"),
					cur,
				})
			}
			output.Table([]string{"id", "device", "location", "ip", "method", "last active", "current"}, rows)
			return nil
		},
	}
}

func authSessionRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <sessionId>",
		Short: "Revoke a browser session (signs that device out)",
		Long: "Revoke one browser session. The server refuses to revoke the session\n" +
			"making the request. From a browser, sign out instead.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("revoke session %s (that device is signed out)", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/auth/sessions/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("revoked session %s", args[0])
			return nil
		},
	}
}

func authSessionRevokeAllCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke-all",
		Short: "Sign out everywhere: revoke all sessions and delete every API token",
		Long: "Revoke every browser session (except the one making the request, which\n" +
			"for a CLI call is none of them) and delete ALL of your personal API\n" +
			"tokens. The server treats \"sign out everywhere\" as everywhere.\n\n" +
			"That includes the token this CLI is signed in with: the command succeeds,\n" +
			"then this CLI is locked out until you run `orchard auth login` again.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm("revoke all sessions and delete every API token (including the one this CLI uses)", yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/auth/sessions/revoke-all", nil, &raw); err != nil {
				return err
			}
			output.Successf("revoked %s session(s) and all API tokens", pick(raw, "revokedCount"))
			output.Warnf("this CLI's token was deleted too. Run `orchard auth login` to reconnect.")
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func displayUser(me map[string]any) string {
	for _, k := range []string{"email", "name", "username", "id", "sub"} {
		if v, ok := me[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return output.SanitizeLine(s)
			}
		}
	}
	return "(unknown)"
}
