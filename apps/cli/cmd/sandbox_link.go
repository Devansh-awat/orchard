package cmd

import (
	"net/http"

	"github.com/spf13/cobra"

	"github.com/hackclub/orchard/cli/internal/output"
)

func sandboxLinkCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "link",
		Aliases: []string{"links"},
		Short:   "Attach Orchard projects so their env vars land in the sandbox",
		Long: "An attached project environment is written to ~/.config/orchard/env/<project>.env\n" +
			"inside the sandbox (shared vars plus DATABASE_URL when the database is public) and\n" +
			"sourced by every login shell. Secret values stay write-only and appear as comments.\n" +
			"Restart opencode after attaching so the agent picks the vars up.",
	}
	c.AddCommand(sandboxLinkListCmd(), sandboxLinkAddCmd(), sandboxLinkRemoveCmd())
	return c
}

func sandboxLinkListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <sandbox>",
		Aliases: []string{"ls"},
		Short:   "List projects attached to a sandbox",
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
			if err := cl.GetJSON(cmd.Context(), sandboxPath(str(sb["id"]), "links"), &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, l := range asList(raw["links"]) {
				project, _ := l["project"].(map[string]any)
				env, _ := l["environment"].(map[string]any)
				rows = append(rows, []string{pick(project, "slug"), pick(env, "name"), pick(l, "envFile")})
			}
			if len(rows) == 0 {
				output.Println(output.Dim("no projects attached"))
				return nil
			}
			output.Table([]string{"project", "environment", "env file"}, rows)
			return nil
		},
	}
}

func sandboxLinkAddCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add <sandbox> <project>",
		Short: "Attach a project environment to a sandbox (host only); --env picks the environment",
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
			project, err := resolveProject(cmd.Context(), cl, args[1])
			if err != nil {
				return err
			}
			body := map[string]any{"projectId": str(project["id"])}
			if envFlag != "" {
				env, err := resolveEnv(cmd.Context(), cl, str(project["id"]), envFlag)
				if err != nil {
					return err
				}
				body["environmentId"] = str(env["id"])
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, sandboxPath(str(sb["id"]), "links"), body, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			env, _ := raw["environment"].(map[string]any)
			output.Successf("attached %s (%s) to %s at %s", pick(project, "slug"), pick(env, "name"), pick(sb, "name"), pick(raw, "envFile"))
			return nil
		},
	}
}

func sandboxLinkRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <sandbox> <project>",
		Aliases: []string{"rm"},
		Short:   "Detach a project from a sandbox (host only)",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			sb, err := resolveSandbox(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			project, err := resolveProject(cmd.Context(), cl, args[1])
			if err != nil {
				return err
			}
			path := sandboxPath(str(sb["id"]), "links", str(project["id"]))
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return sandboxFeatureError(err)
			}
			output.Successf("detached %s from %s", pick(project, "slug"), pick(sb, "name"))
			return nil
		},
	}
}

func sandboxSessionPreviewCmd() *cobra.Command {
	var deployment string
	var remove bool
	c := &cobra.Command{
		Use:   "preview <sandbox> <session>",
		Short: "Deploy a session branch as a gh-<slug> preview environment (host only)",
		Long: "Pushes the session branch and deploys it into the gh-<slug> environment of the\n" +
			"project from --project or the saved context, copying the config of the deployment\n" +
			"that builds the same repo (or --deployment).\n" +
			"Run it again to redeploy the latest commit; --remove tears the environment down.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
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
			path := sandboxPath(id, "sessions", str(s["id"]), "preview-deploy")
			var raw map[string]any
			if remove {
				if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, &raw); err != nil {
					return sandboxFeatureError(err)
				}
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				if raw["removed"] == true {
					output.Successf("removed the preview of %s", pick(s, "slug"))
				} else {
					output.Println(output.Dim("this session has no preview"))
				}
				return nil
			}
			pid, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"projectId": pid}
			if deployment != "" {
				body["deploymentId"] = deployment
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, path, body, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			verb := "deployed"
			if raw["redeployed"] == true {
				verb = "redeployed"
			}
			url := pick(raw, "url")
			if url == "" {
				url = "(no URL yet)"
			}
			output.Successf("%s %s to the preview at %s", verb, pick(raw, "branch"), url)
			if skipped := asStrings(raw["skippedEnv"]); len(skipped) > 0 {
				output.Warnf("left out %d var(s) bound to the source's resources: %v", len(skipped), skipped)
			}
			return nil
		},
	}
	c.Flags().StringVar(&deployment, "deployment", "", "Deployment id whose config is copied")
	c.Flags().BoolVar(&remove, "remove", false, "Tear the preview environment down instead")
	return c
}
