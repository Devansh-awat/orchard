package cmd

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func importCmd() *cobra.Command {
	var name string
	var port int
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:     "import <owner/repo[#branch] | url>",
		GroupID: groupCore,
		Short:   "Import a GitHub repo: project, build, deploy and URL in one shot",
		Long: "Creates a project named after the repo, detects how to build it (Dockerfile\n" +
			"or automatic), starts the first build with auto-deploy enabled, and attaches\n" +
			"a protected platform URL. The org comes from --org or the saved context.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}

			repo, branch, _ := strings.Cut(args[0], "#")
			if repo == "" {
				return errors.New("expected owner/repo[#branch] or a repository URL")
			}
			body := map[string]any{"organizationId": orgID, "repoUrl": repo}
			if branch != "" {
				body["branch"] = branch
			}
			overrides := map[string]any{}
			if name != "" {
				overrides["name"] = name
			}
			if port > 0 {
				overrides["port"] = port
			}
			if len(overrides) > 0 {
				body["overrides"] = overrides
			}

			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/import", body, &raw); err != nil {
				return err
			}

			output.Successf("imported %s as project %s", repo, str(raw["projectSlug"]))
			if fw := str(raw["framework"]); fw != "" {
				output.Warnf("detected %s (%s build)", fw, str(raw["buildType"]))
			}
			if u := str(raw["url"]); u != "" {
				output.Successf("will be live at %s (visible to your org until made public)", u)
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			}

			id := str(raw["deploymentId"])
			if *wait && id != "" {
				if werr := runWait(cmd.Context(), cl, deployWaitBuild(id), *timeout); werr != nil {
					return werr
				}
				printDeploySuccess(cmd.Context(), cl, cfg.APIURL, id)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "override the project/deployment name (default: repo name)")
	c.Flags().IntVar(&port, "port", 0, "override the detected port")
	wait, timeout = addWaitFlags(c)
	return c
}
