package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func gitCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "git",
		GroupID: groupResources,
		Aliases: []string{"git-providers", "providers"},
		Short:   "Git providers you have linked with your own token",
		Long: `A git provider is a GitLab, Gitea, Forgejo, Codeberg, Bitbucket, self-hosted
GitHub, or any https git host, linked to your account with your own token,
like the GitHub link. Orchard only shows you what that token can see.
Apps deploy from it with: orchard deploy create --git <provider> --repo <url>.
Auto-deploy uses one webhook URL per provider, signed with its own secret.`,
	}
	c.AddCommand(gitListCmd(), gitAddCmd(), gitRemoveCmd(), gitWebhookCmd(), gitReposCmd(), gitBranchesCmd(), gitDetectCmd())
	return c
}

func gitPath(rest ...string) string {
	p := "/users/me/git-connections"
	for _, r := range rest {
		p += "/" + r
	}
	return p
}

func gitResolve(cmd *cobra.Command, nameOrID string) (conn map[string]any, err error) {
	cl, _, err := client()
	if err != nil {
		return nil, err
	}
	var raw any
	if err := cl.GetJSON(cmd.Context(), gitPath(), &raw); err != nil {
		return nil, err
	}
	for _, c := range asList(raw) {
		if pick(c, "id") == nameOrID || strings.EqualFold(pick(c, "name"), nameOrID) {
			return c, nil
		}
	}
	return nil, fmt.Errorf("no git provider named %q (see: orchard git list)", nameOrID)
}

func gitListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List git providers",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), gitPath(), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, c := range asList(raw) {
				rows = append(rows, []string{pick(c, "name"), pick(c, "provider"), pick(c, "host"), pick(c, "id")})
			}
			if len(rows) == 0 {
				output.Println(output.Dim("No git providers. Add one with: orchard git add --provider gitlab --name work --token <token>"))
				return nil
			}
			output.Table([]string{"name", "provider", "host", "id"}, rows)
			return nil
		},
	}
}

func gitAddCmd() *cobra.Command {
	var provider, name, baseURL, username, token string
	c := &cobra.Command{
		Use:   "add --provider <kind> --name <name> --token <token>",
		Short: "Connect a git provider",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"provider": provider, "name": name, "token": token}
			if baseURL != "" {
				body["baseUrl"] = baseURL
			}
			if username != "" {
				body["username"] = username
			}
			var out map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, gitPath(), body, &out); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(out)
			}
			output.Printf("Connected %s (%s at %s)\n", output.SanitizeLine(pick(out, "name")), output.SanitizeLine(pick(out, "provider")), output.SanitizeLine(pick(out, "host")))
			output.Printf("Webhook URL: %s\n", output.SanitizeLine(pick(out, "webhookPath")))
			output.Println(output.Dim("Get the secret with: orchard git webhook " + output.SanitizeLine(pick(out, "name"))))
			return nil
		},
	}
	c.Flags().StringVar(&provider, "provider", "", "github | gitlab | gitea | bitbucket | generic")
	c.Flags().StringVar(&name, "name", "", "short name used with --git on deploy create")
	c.Flags().StringVar(&baseURL, "url", "", "base URL of the host (default: the public instance of the provider)")
	c.Flags().StringVar(&username, "username", "", "Atlassian account email for a bitbucket API token, or the username for a generic host")
	c.Flags().StringVar(&token, "token", "", "token or password")
	_ = c.MarkFlagRequired("provider")
	_ = c.MarkFlagRequired("name")
	_ = c.MarkFlagRequired("token")
	return c
}

func gitRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <name>",
		Short: "Disconnect a git provider",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			conn, err := gitResolve(cmd, args[0])
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, gitPath(url.PathEscape(pick(conn, "id"))), nil, nil); err != nil {
				return err
			}
			output.Printf("Removed %s\n", output.SanitizeLine(pick(conn, "name")))
			return nil
		},
	}
}

func gitWebhookCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "webhook <name>",
		Short: "Show the webhook URL and secret to paste into the forge",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			conn, err := gitResolve(cmd, args[0])
			if err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			var out map[string]any
			if err := cl.GetJSON(cmd.Context(), gitPath(url.PathEscape(pick(conn, "id")), "webhook-secret"), &out); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(map[string]any{"url": cfg.APIURL + pick(conn, "webhookPath"), "secret": pick(out, "secret")})
			}
			output.Printf("URL:    %s%s\n", cfg.APIURL, output.SanitizeLine(pick(conn, "webhookPath")))
			output.Printf("Secret: %s\n", output.SanitizeLine(pick(out, "secret")))
			return nil
		},
	}
}

func gitReposCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "repos <name>",
		Short: "List repositories the token can see",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			conn, err := gitResolve(cmd, args[0])
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), gitPath(url.PathEscape(pick(conn, "id")), "repositories"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, r := range asList(raw) {
				rows = append(rows, []string{pick(r, "fullName"), pick(r, "defaultBranch"), pick(r, "url")})
			}
			output.Table([]string{"repository", "default branch", "url"}, rows)
			return nil
		},
	}
}

func gitBranchesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "branches <name> <owner/repo>",
		Short: "List branches of a repository",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			conn, err := gitResolve(cmd, args[0])
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			path := gitPath(url.PathEscape(pick(conn, "id")), "branches") + "?repo=" + url.QueryEscape(args[1])
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, b := range asList(raw) {
				rows = append(rows, []string{pick(b, "name"), observeTruncate(pick(b, "sha"), 12)})
			}
			output.Table([]string{"branch", "sha"}, rows)
			return nil
		},
	}
}

func gitDetectCmd() *cobra.Command {
	var branch string
	c := &cobra.Command{
		Use:   "detect <name> <owner/repo>",
		Short: "Inspect a repository the way the new app form does",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			conn, err := gitResolve(cmd, args[0])
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			path := gitPath(url.PathEscape(pick(conn, "id")), "detect") + "?repo=" + url.QueryEscape(args[1]) + "&branch=" + url.QueryEscape(branch)
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Printf("Build:      %s\n", output.SanitizeLine(pick(raw, "buildType")))
			if d := pick(raw, "dockerfilePath"); d != "" {
				output.Printf("Dockerfile: %s\n", d)
			}
			if f := pick(raw, "framework"); f != "" {
				output.Printf("Framework:  %s\n", f)
			}
			return nil
		},
	}
	c.Flags().StringVar(&branch, "branch", "", "branch to inspect (default: the repository default)")
	return c
}
