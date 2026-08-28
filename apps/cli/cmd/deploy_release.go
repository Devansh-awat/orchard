package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployRollbackCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "rollback <id> <historyId>",
		Short: "Roll a deployment back to a previous image (see `deploy history`)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("rollback deployment %s to image history entry %s", args[0], args[1]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "rollback", url.PathEscape(args[1])), nil, nil); err != nil {
				return err
			}
			output.Successf("rolled back %s to %s", args[0], args[1])
			if *wait {
				return runWait(cmd.Context(), cl, deployWaitRunning(args[0]), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func deployImageCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "image",
		Short: "Manage the Docker image of an image-source deployment",
	}
	c.AddCommand(deployImageSetCmd())
	return c
}

func deployImageSetCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "set <id> <image>",
		Short: "Change the image (GitHub-built deployments must use `deploy rebuild`)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"image": args[1]}
			if err := cl.Send(cmd.Context(), http.MethodPatch, deployPath(args[0], "image"), body, nil); err != nil {
				return err
			}
			output.Successf("set image of %s to %s", args[0], args[1])
			if *wait {
				return runWait(cmd.Context(), cl, deployWaitRunning(args[0]), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func deployHistoryCmd() *cobra.Command {
	var logsID string
	c := &cobra.Command{
		Use:   "history <id>",
		Short: "Show a deployment's image history",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if logsID != "" {
				var raw map[string]any
				if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "image-history", url.PathEscape(logsID), "logs"), &raw); err != nil {
					return err
				}
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				logs := str(raw["logs"])
				fmt.Print(logs)
				if logs != "" && !strings.HasSuffix(logs, "\n") {
					fmt.Println()
				}
				return nil
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "image-history"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, e := range asList(raw) {
				rows = append(rows, []string{
					pick(e, "id"),
					pick(e, "image"),
					pick(e, "tag"),
					pick(e, "branch"),
					pick(e, "isActive"),
					pick(e, "createdAt"),
				})
			}
			output.Table([]string{"id", "image", "tag", "branch", "active", "created"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&logsID, "logs", "", "print build logs for one image history entry")
	return c
}

func deployKilledCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "killed",
		Short: "Inspect logs captured from killed containers",
	}
	c.AddCommand(deployKilledListCmd(), deployKilledLogsCmd())
	return c
}

func deployKilledListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <id>",
		Aliases: []string{"ls"},
		Short:   "List killed-container log captures",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "killed-containers"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, e := range asList(raw) {
				rows = append(rows, []string{
					pick(e, "entryId"),
					pick(e, "pod"),
					pick(e, "container"),
					pick(e, "reason"),
					pick(e, "exitCode"),
					pick(e, "finishedAt", "capturedAt"),
				})
			}
			output.Table([]string{"entry", "pod", "container", "reason", "exit", "finished"}, rows)
			return nil
		},
	}
}

func deployKilledLogsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logs <id> <entryId>",
		Short: "Print the captured logs of a killed container",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "killed-containers", url.PathEscape(args[1]), "logs"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			logs := str(raw["logs"])
			fmt.Print(logs)
			if logs != "" && !strings.HasSuffix(logs, "\n") {
				fmt.Println()
			}
			return nil
		},
	}
}

func deployAutoDeployCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "auto-deploy",
		Short: "Manage push-to-deploy for GitHub deployments",
	}
	c.AddCommand(deployAutoDeployStatusCmd(), deployAutoDeployEnableCmd(), deployAutoDeployDisableCmd())
	return c
}

func deployAutoDeployStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <id>",
		Short: "Show auto-deploy configuration",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "auto-deploy"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"enabled", pick(raw, "enabled", "autoDeployEnabled")},
				{"branch", pick(raw, "branch", "autoDeployBranch")},
				{"repo", pick(raw, "githubRepo", "repo")},
				{"app installed", pick(raw, "appInstalled")},
			})
			return nil
		},
	}
}

func deployAutoDeployEnableCmd() *cobra.Command {
	var branch string
	c := &cobra.Command{
		Use:   "enable <id>",
		Short: "Rebuild automatically on pushes to a branch",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"branch": branch}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "auto-deploy", "enable"), body, nil); err != nil {
				return err
			}
			output.Successf("enabled auto-deploy on %s from branch %s", args[0], branch)
			return nil
		},
	}
	c.Flags().StringVar(&branch, "branch", "", "branch to auto-deploy from (required)")
	_ = c.MarkFlagRequired("branch")
	return c
}

func deployAutoDeployDisableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "disable <id>",
		Short: "Stop auto-deploying on pushes",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "auto-deploy", "disable"), nil, nil); err != nil {
				return err
			}
			output.Successf("disabled auto-deploy on %s", args[0])
			return nil
		},
	}
}

func deployWebhookTokenCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "webhook-token",
		Aliases: []string{"webhook-tokens"},
		Short:   "Manage deploy webhook trigger tokens",
	}
	c.AddCommand(deployWebhookTokenListCmd(), deployWebhookTokenCreateCmd(), deployWebhookTokenDeleteCmd())
	return c
}

func deployWebhookTokenListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list <id>",
		Aliases: []string{"ls"},
		Short:   "List webhook tokens (secrets are never shown again)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "webhook-tokens"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, t := range asList(raw) {
				rows = append(rows, []string{
					pick(t, "id"),
					pick(t, "label"),
					pick(t, "createdAt"),
				})
			}
			output.Table([]string{"id", "label", "created"}, rows)
			return nil
		},
	}
}

func deployWebhookTokenCreateCmd() *cobra.Command {
	var label string
	c := &cobra.Command{
		Use:   "create <id>",
		Short: "Mint a webhook token that triggers a rebuild via POST",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{}
			if label != "" {
				body["label"] = label
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "webhook-tokens"), body, &raw); err != nil {
				return err
			}
			token := str(raw["token"])
			trigger := strings.TrimRight(cfg.APIURL, "/") + "/apiv1/webhooks/deploy/" + url.PathEscape(token)
			output.Successf("created webhook token %s", str(raw["id"]))
			output.Warnf("the token is shown only once — store it now")
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"token", token},
				{"trigger url", "POST " + trigger},
			})
			return nil
		},
	}
	c.Flags().StringVar(&label, "label", "", "human-readable label for the token")
	return c
}

func deployWebhookTokenDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id> <tokenId>",
		Aliases: []string{"rm"},
		Short:   "Delete a webhook token",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("delete webhook token %s (its trigger URL stops working)", args[1]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, deployPath(args[0], "webhook-tokens", url.PathEscape(args[1])), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted webhook token %s", args[1])
			return nil
		},
	}
}

func deployGithubDeploymentsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "github-deployments <id>",
		Short: "List GitHub deployment status entries for this deployment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "github-deployments"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, d := range asList(raw) {
				sha := pick(d, "commitSha")
				if len(sha) > 7 {
					sha = sha[:7]
				}
				rows = append(rows, []string{
					output.Status(pick(d, "status")),
					pick(d, "environment"),
					pick(d, "ref"),
					sha,
					pick(d, "createdAt"),
				})
			}
			output.Table([]string{"status", "environment", "ref", "commit", "created"}, rows)
			return nil
		},
	}
}
