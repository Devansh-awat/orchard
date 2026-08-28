package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func composeCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "compose",
		GroupID: groupResources,
		Aliases: []string{"compose-stack", "compose-stacks", "stack", "stacks"},
		Short:   "Manage Docker Compose stacks",
	}
	c.AddCommand(
		composeListCmd(),
		composeGetCmd(),
		composeDeployCmd(),
		composeRedeployCmd(),
		composeAutoDeployCmd(),
		composeDeleteCmd(),
	)
	return c
}

func composeStackPath(id string, rest ...string) string {
	p := "/compose-stacks/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

// composeRepoURL turns owner/repo[#branch] (or a full repo URL) into the
// repoUrl + branch the API expects; the server only parses github.com URLs.
func composeRepoURL(github string) (repoURL, branch string, err error) {
	repo, branch, _ := strings.Cut(github, "#")
	if strings.Contains(repo, "://") || strings.HasPrefix(repo, "git@") {
		return repo, branch, nil
	}
	parts := strings.Split(repo, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("--github expects owner/repo[#branch] or a repo URL, got %q", github)
	}
	return "https://github.com/" + repo, branch, nil
}

func composeListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List compose stacks in the current project",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(projectID)+"/compose-stacks", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, s := range asList(raw) {
				rows = append(rows, []string{
					pick(s, "id"),
					pick(s, "name"),
					output.Status(pick(s, "status")),
					pick(s, "githubRepo"),
					pick(s, "githubBranch"),
					strconv.Itoa(len(asList(s["deployments"]))),
					pick(s, "autoDeployEnabled"),
				})
			}
			output.Table([]string{"id", "name", "status", "repo", "branch", "services", "auto-deploy"}, rows)
			return nil
		},
	}
}

func composeGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <stackId>",
		Short: "Show a compose stack and its service deployments",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), composeStackPath(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			children := asList(raw["deployments"])
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"status", output.Status(pick(raw, "status"))},
				{"repo", pick(raw, "githubRepo")},
				{"branch", pick(raw, "githubBranch")},
				{"compose path", pick(raw, "composePath")},
				{"auto-deploy", pick(raw, "autoDeployEnabled")},
				{"services", strconv.Itoa(len(children))},
			}
			for _, opt := range [][2]string{
				{"auto-deploy branch", pick(raw, "autoDeployBranch")},
				{"build status", pick(raw, "buildStatus")},
				{"last commit", pick(raw, "lastCommitSha")},
				{"last error", pick(raw, "lastError")},
				{"created", pick(raw, "createdAt")},
			} {
				if opt[1] != "" {
					pairs = append(pairs, opt)
				}
			}
			output.KV(pairs)
			if len(children) == 0 {
				return nil
			}
			fmt.Println()
			rows := [][]string{}
			for _, d := range children {
				rows = append(rows, []string{
					pick(d, "composeServiceName"),
					pick(d, "id"),
					pick(d, "name"),
					output.Status(pick(d, "status")),
					pick(d, "image"),
					pick(d, "replicas"),
				})
			}
			output.Table([]string{"service", "deployment", "name", "status", "image", "replicas"}, rows)
			return nil
		},
	}
}

func composeDeployCmd() *cobra.Command {
	var name, github, path string
	var autoDeploy bool
	c := &cobra.Command{
		Use:   "deploy",
		Short: "Deploy a compose stack from a GitHub repo's compose file",
		Long: "Fetch a docker-compose file from GitHub and deploy each service as a\n" +
			"child deployment. The API creates every service before responding, so the\n" +
			"returned stack is already in a terminal state (no --wait needed).",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			repoURL, branch, err := composeRepoURL(github)
			if err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{
				"name":              name,
				"repoUrl":           repoURL,
				"composePath":       path,
				"autoDeployEnabled": autoDeploy,
			}
			if branch != "" {
				body["branch"] = branch
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/"+url.PathEscape(projectID)+"/compose-stacks/from-github", body, &raw); err != nil {
				return err
			}
			services := len(asList(raw["deployments"]))
			output.Successf("created compose stack %s (%s) with %d service(s)", pick(raw, "name"), str(raw["id"]), services)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "stack name (required)")
	c.Flags().StringVar(&github, "github", "", "GitHub source as owner/repo[#branch] or a repo URL (required)")
	c.Flags().StringVar(&path, "path", "docker-compose.yml", "path to the compose file in the repo")
	c.Flags().BoolVar(&autoDeploy, "auto-deploy", false, "rebuild services automatically on pushes to the branch")
	_ = c.MarkFlagRequired("name")
	_ = c.MarkFlagRequired("github")
	return c
}

func composeRedeployCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "redeploy <stackId>",
		Short: "Re-pull the compose file and recreate every service deployment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, composeStackPath(args[0], "redeploy"), nil, &raw); err != nil {
				return err
			}
			output.Successf("redeployed compose stack %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func composeAutoDeployCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "auto-deploy",
		Short: "Toggle push-to-deploy for a stack and its service deployments",
	}
	c.AddCommand(composeAutoDeploySetCmd(true), composeAutoDeploySetCmd(false))
	return c
}

func composeAutoDeploySetCmd(enabled bool) *cobra.Command {
	verb := "enable"
	if !enabled {
		verb = "disable"
	}
	return &cobra.Command{
		Use:   verb + " <stackId>",
		Short: strings.ToUpper(verb[:1]) + verb[1:] + " auto-deploy for the stack",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"enabled": enabled}
			if err := cl.Send(cmd.Context(), http.MethodPut, composeStackPath(args[0], "auto-deploy"), body, nil); err != nil {
				return err
			}
			output.Successf("%sd auto-deploy on compose stack %s", verb, args[0])
			return nil
		},
	}
}

func composeDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <stackId>",
		Aliases: []string{"rm"},
		Short:   "Delete a compose stack and all of its service deployments",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("permanently delete compose stack %s and all of its service deployments", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, composeStackPath(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted compose stack %s", args[0])
			return nil
		},
	}
}
