package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/config"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func authCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "auth",
		GroupID: groupCore,
		Short:   "Manage authentication",
	}
	c.AddCommand(authLoginCmd(), authStatusCmd(), authLogoutCmd())
	return c
}

func authLoginCmd() *cobra.Command {
	var token, apiURL, webURL string
	var noBrowser, withToken bool
	c := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with Orchard",
		Long: "Log in via your browser (default): Orchard mints a personal API token\n" +
			"using your existing session and hands it back over a local callback.\n\n" +
			"Or paste a token manually with --token (create one under Settings → API\n" +
			"Tokens, or set ORCHARD_API_TOKEN in the environment).",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, _ := config.Load()
			if apiURL != "" {
				cfg.APIURL = apiURL
			}

			// Manual token path: explicit --token, --with-token prompt, or a
			// non-interactive stdin (pipe).
			if token != "" || withToken || !output.IsTTY() {
				if token == "" {
					fmt.Fprint(os.Stderr, "Paste your Orchard API token (orch_…): ")
					r := bufio.NewReader(os.Stdin)
					line, _ := r.ReadString('\n')
					token = strings.TrimSpace(line)
				}
				if token == "" {
					return fmt.Errorf("no token provided")
				}
				if !strings.HasPrefix(token, "orch_") {
					output.Warnf("token does not start with orch_ — continuing anyway")
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
				output.Successf("logged in to %s as %s", cfg.APIURL, displayUser(me))
				return nil
			}

			// Browser flow. The web app is served from the same origin as the
			// API unless overridden.
			base := webURL
			if base == "" {
				base = cfg.APIURL
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
			fmt.Println(output.Dim("user: ") + displayUser(me))
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

func displayUser(me map[string]any) string {
	for _, k := range []string{"email", "name", "username", "id", "sub"} {
		if v, ok := me[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return "(unknown)"
}
