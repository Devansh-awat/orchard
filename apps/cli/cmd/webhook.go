package cmd

import (
	"net/http"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func webhookCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "webhook",
		GroupID: groupResources,
		Aliases: []string{"webhooks"},
		Short:   "Trigger deploy webhooks",
	}
	c.AddCommand(webhookDeployCmd())
	return c
}

func webhookDeployCmd() *cobra.Command {
	var image, tag string
	c := &cobra.Command{
		Use:   "deploy <token>",
		Short: "Trigger a deployment via a webhook token (no login required)",
		Long: "Trigger a deploy webhook minted with `orchard deploy webhook-token create`.\n\n" +
			"The route is public: only the webhook token authenticates the call, so a\n" +
			"token-less CI job can run this without `orchard auth login`. Without flags\n" +
			"the deployment restarts; --image/--tag switch the image first (Docker-image\n" +
			"deployments only).",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			// Built without RequireToken: the webhook token itself is the only
			// credential. It rides the Authorization header (the form the server
			// prefers over /webhooks/deploy/:token, which leaks the secret into
			// proxy logs). The stored login token must not be sent either, since
			// the server resolves the header token first and would reject it.
			cl := api.New(cfg.APIURL, args[0])
			body := map[string]any{}
			if image != "" {
				body["image"] = image
			}
			if tag != "" {
				body["tag"] = tag
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/webhooks/deploy", body, &raw); err != nil {
				return err
			}
			output.Successf("webhook triggered %s of deployment %s", pick(raw, "action"), pick(raw, "deploymentId"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&image, "image", "", "switch to this image before restarting (Docker-image deployments only)")
	c.Flags().StringVar(&tag, "tag", "", "image tag to deploy (server defaults to latest when only --image is set)")
	return c
}
