package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

// githubCmd lives in the utility group: it manages the account-level GitHub
// integration rather than an org/project-scoped resource.
func githubCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "github",
		GroupID: groupUtility,
		Aliases: []string{"gh"},
		Short:   "Manage the GitHub integration",
		Long: "Link your GitHub account, install the GitHub App, and browse\n" +
			"repositories, branches, Dockerfiles, and file trees used as deploy sources.",
	}
	c.AddCommand(
		githubStatusCmd(),
		githubLinkCmd(),
		githubUnlinkCmd(),
		githubInstallCmd(),
		githubInstallationsCmd(),
		githubReposCmd(),
		githubBranchesCmd(),
		githubDockerfilesCmd(),
		githubDockerfileInfoCmd(),
		githubContentsCmd(),
	)
	return c
}

// githubRepoPath builds /github/repositories/:owner/:repo[/rest] from an
// owner/repo argument.
func githubRepoPath(ownerRepo string, rest ...string) (string, error) {
	owner, repo, ok := strings.Cut(ownerRepo, "/")
	if !ok || owner == "" || repo == "" {
		return "", fmt.Errorf("expected owner/repo, got %q", ownerRepo)
	}
	p := "/github/repositories/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p, nil
}

// githubLinkURL is the browser entrypoint for the OAuth link flow. The route
// is public and driven by the web session cookie plus redirects, so the CLI
// hands it to a browser instead of calling it with the API token.
func githubLinkURL(apiURL string) string {
	return strings.TrimRight(apiURL, "/") + "/apiv1/github/link"
}

func githubJoin(v any) string {
	items, ok := v.([]any)
	if !ok {
		return ""
	}
	parts := []string{}
	for _, it := range items {
		switch t := it.(type) {
		case string:
			parts = append(parts, t)
		case float64:
			parts = append(parts, strconv.FormatFloat(t, 'f', -1, 64))
		}
	}
	return strings.Join(parts, ", ")
}

func githubShortSHA(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	sha := str(m["sha"])
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func githubStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the linked GitHub account and app installations",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/github/status", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"linked", fmt.Sprintf("%v", raw["linked"] == true)},
			}
			if u := pick(raw, "username"); u != "" {
				pairs = append(pairs, [2]string{"username", u})
			}
			if raw["tokenExpired"] == true {
				pairs = append(pairs, [2]string{"token expired", "true"})
			}
			pairs = append(pairs, [2]string{"installations", strconv.Itoa(len(asList(raw["installations"])))})
			output.KV(pairs)
			return nil
		},
	}
}

func githubLinkCmd() *cobra.Command {
	var open bool
	c := &cobra.Command{
		Use:   "link",
		Short: "Link your GitHub account (opens the OAuth flow in a browser)",
		Long: "Print the URL that starts the GitHub OAuth link flow.\n\n" +
			"The flow relies on your Orchard web session and browser redirects, so it\n" +
			"can't complete inside the CLI: open the URL in a browser where you are\n" +
			"signed in to Orchard.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			u := githubLinkURL(cfg.APIURL)
			if open && output.IsTTY() {
				_ = api.OpenBrowser(u)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(map[string]any{"url": u})
			}
			output.Fprintln(os.Stderr, output.Dim("open this URL in a browser where you are signed in to Orchard:"))
			output.Println(output.Sanitize(u))
			return nil
		},
	}
	c.Flags().BoolVar(&open, "open", false, "open the URL in your browser")
	return c
}

func githubUnlinkCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unlink",
		Short: "Unlink your GitHub account",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm("unlink your GitHub account from Orchard", yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/github/unlink", nil, nil); err != nil {
				return err
			}
			output.Successf("GitHub account unlinked")
			return nil
		},
	}
}

func githubInstallCmd() *cobra.Command {
	var open bool
	c := &cobra.Command{
		Use:   "install",
		Short: "Get the GitHub App installation URL",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/github/app/install", &raw); err != nil {
				return err
			}
			u := pick(raw, "url")
			if open && output.IsTTY() && u != "" {
				_ = api.OpenBrowser(u)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Println(output.Sanitize(u))
			return nil
		},
	}
	c.Flags().BoolVar(&open, "open", false, "open the URL in your browser")
	return c
}

func githubInstallationsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "installations",
		Short: "List GitHub App installations available to your account",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/github/app/installations", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, m := range asList(raw) {
				rows = append(rows, []string{
					pick(m, "id"),
					pick(m, "installationId"),
					pick(m, "accountLogin"),
					pick(m, "accountType"),
					pick(m, "repositorySelection"),
				})
			}
			output.Table([]string{"id", "installation", "account", "type", "repos"}, rows)
			return nil
		},
	}
}

func githubReposCmd() *cobra.Command {
	var all bool
	c := &cobra.Command{
		Use:     "repos",
		Aliases: []string{"repositories"},
		Short:   "List repositories you can deploy from",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := "/github/repositories"
			if all {
				path += "?all=true"
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, m := range asList(raw["repositories"]) {
				visibility := "public"
				if m["private"] == true {
					visibility = "private"
				}
				rows = append(rows, []string{
					pick(m, "full_name", "name"),
					visibility,
					pick(m, "default_branch"),
				})
			}
			output.Table([]string{"name", "visibility", "default branch"}, rows)
			if src := pick(raw, "source"); src != "" {
				output.Println(output.Dim("source: " + src))
			}
			return nil
		},
	}
	c.Flags().BoolVar(&all, "all", false, "fetch more pages from the OAuth fallback listing")
	return c
}

func githubBranchesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "branches <owner/repo>",
		Short: "List a repository's branches",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := githubRepoPath(args[0], "branches")
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, b := range asList(raw) {
				rows = append(rows, []string{pick(b, "name"), githubShortSHA(b["commit"])})
			}
			output.Table([]string{"name", "commit"}, rows)
			return nil
		},
	}
}

func githubDockerfilesCmd() *cobra.Command {
	var branch string
	c := &cobra.Command{
		Use:   "dockerfiles <owner/repo>",
		Short: "Find Dockerfiles in a repository",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := githubRepoPath(args[0], "dockerfiles")
			if err != nil {
				return err
			}
			if branch != "" {
				path += "?" + url.Values{"branch": {branch}}.Encode()
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			items, _ := raw.([]any)
			if len(items) == 0 {
				output.Warnf("no Dockerfiles found in %s", args[0])
				return nil
			}
			for _, it := range items {
				if s, ok := it.(string); ok {
					output.Println(output.Sanitize(s))
				}
			}
			return nil
		},
	}
	c.Flags().StringVar(&branch, "branch", "", "branch to search (default: the repo's default branch)")
	return c
}

func githubDockerfileInfoCmd() *cobra.Command {
	var branch string
	c := &cobra.Command{
		Use:   "dockerfile-info <owner/repo> <dockerfile-path>",
		Short: "Show exposed ports, env vars, and build stages of a Dockerfile",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := githubRepoPath(args[0], "dockerfile-info")
			if err != nil {
				return err
			}
			q := url.Values{"dockerfilePath": {args[1]}}
			if branch != "" {
				q.Set("branch", branch)
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), path+"?"+q.Encode(), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"dockerfile", args[1]},
				{"exposed ports", githubJoin(raw["exposedPorts"])},
				{"stages", githubJoin(raw["stages"])},
			}
			for _, e := range asList(raw["envVars"]) {
				pairs = append(pairs, [2]string{"env " + pick(e, "key"), pick(e, "value")})
			}
			output.KV(pairs)
			return nil
		},
	}
	c.Flags().StringVar(&branch, "branch", "", "branch to read from (default: the repo's default branch)")
	return c
}

func githubContentsCmd() *cobra.Command {
	var branch string
	c := &cobra.Command{
		Use:     "contents <owner/repo> [path]",
		Aliases: []string{"ls"},
		Short:   "List files and directories in a repository",
		Args:    cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := githubRepoPath(args[0], "contents")
			if err != nil {
				return err
			}
			q := url.Values{}
			if len(args) > 1 && args[1] != "" {
				q.Set("path", args[1])
			}
			if branch != "" {
				q.Set("branch", branch)
			}
			if len(q) > 0 {
				path += "?" + q.Encode()
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, m := range asList(raw) {
				rows = append(rows, []string{
					pick(m, "type"),
					pick(m, "name"),
					pick(m, "size"),
					pick(m, "path"),
				})
			}
			output.Table([]string{"type", "name", "size", "path"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&branch, "branch", "", "branch to read from (default: the repo's default branch)")
	return c
}
