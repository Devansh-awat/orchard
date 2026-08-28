package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var notifyChannelTypes = []string{"discord", "slack", "webhook", "email"}

var notifyEvents = []string{
	"deploy.succeeded",
	"deploy.failed",
	"pod.crashing",
	"pod.recovered",
	"backup.completed",
	"backup.failed",
	"job.succeeded",
	"job.failed",
}

func notifyCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "notify",
		GroupID: groupResources,
		Aliases: []string{"notification", "notifications"},
		Short:   "Manage org notification channels",
		Long: "Notification channels deliver org events (deploys, pod crashes, backups,\n" +
			"job runs) to Discord, Slack, generic webhooks, or email. Channels belong\n" +
			"to the organization and require org admin; creating, updating, and\n" +
			"testing them also requires the Notifications early-access feature.",
	}
	c.AddCommand(notifyChannelCmd(), notifyDeliveriesCmd())
	return c
}

func notifyChannelCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "channel",
		Aliases: []string{"channels"},
		Short:   "Manage notification channels",
	}
	c.AddCommand(
		notifyChannelListCmd(),
		notifyChannelCreateCmd(),
		notifyChannelUpdateCmd(),
		notifyChannelDeleteCmd(),
		notifyChannelTestCmd(),
	)
	return c
}

func notifyChannelPath(orgID, channelID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/notification-channels"
	if channelID != "" {
		p += "/" + url.PathEscape(channelID)
	}
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func notifyList(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func notifyScopeSummary(ch map[string]any) string {
	ids := notifyList(ch["projectIds"])
	switch len(ids) {
	case 0:
		return "all projects"
	case 1:
		return "1 project"
	default:
		return fmt.Sprintf("%d projects", len(ids))
	}
}

func notifyChannelListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the org's notification channels",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), notifyChannelPath(orgID, ""), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, ch := range asList(raw) {
				enabled := ""
				if b, _ := ch["enabled"].(bool); b {
					enabled = "✓"
				}
				rows = append(rows, []string{
					pick(ch, "id"),
					pick(ch, "type"),
					pick(ch, "name"),
					enabled,
					strconv.Itoa(len(notifyList(ch["events"]))),
					notifyScopeSummary(ch),
				})
			}
			output.Table([]string{"id", "type", "name", "enabled", "events", "scope"}, rows)
			return nil
		},
	}
}

const notifyEventsHelp = "Valid --events values:\n" +
	"  deploy.succeeded, deploy.failed    build/deploy outcomes\n" +
	"  pod.crashing, pod.recovered        app health transitions\n" +
	"  backup.completed, backup.failed    database backup outcomes\n" +
	"  job.succeeded, job.failed          scheduled job run outcomes"

func notifyValidateEvents(events []string) error {
	bad := []string{}
	for _, e := range events {
		if !slices.Contains(notifyEvents, e) {
			bad = append(bad, e)
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("unknown event(s): %s (valid: %s)", strings.Join(bad, ", "), strings.Join(notifyEvents, ", "))
	}
	return nil
}

func notifyValidateCreateFlags(typ, urlStr string, emails []string) error {
	if !slices.Contains(notifyChannelTypes, typ) {
		return fmt.Errorf("--type must be one of: %s", strings.Join(notifyChannelTypes, ", "))
	}
	if typ == "email" {
		if len(emails) == 0 {
			return errors.New("--email is required for email channels (repeatable, org members only)")
		}
		if urlStr != "" {
			return errors.New("--url does not apply to email channels")
		}
		return nil
	}
	if urlStr == "" {
		return fmt.Errorf("--url is required for %s channels", typ)
	}
	if len(emails) > 0 {
		return fmt.Errorf("--email does not apply to %s channels", typ)
	}
	return nil
}

func notifyChannelCreateCmd() *cobra.Command {
	var typ, name, urlStr string
	var emails, events, projects []string
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a notification channel in the org",
		Long: "Create a notification channel. Channels fire for every project in the\n" +
			"org unless scoped with --project.\n\n" +
			"Config by type:\n" +
			"  discord  --url    Discord webhook URL\n" +
			"  slack    --url    Slack incoming-webhook URL\n" +
			"  webhook  --url    public http(s) endpoint; requests are HMAC-SHA256\n" +
			"                    signed with a secret printed once on create\n" +
			"  email    --email  1-10 recipients, each an org member (repeatable)\n\n" +
			notifyEventsHelp,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := notifyValidateCreateFlags(typ, urlStr, emails); err != nil {
				return err
			}
			if err := notifyValidateEvents(events); err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"name": name, "type": typ, "events": events}
			if typ == "email" {
				body["config"] = map[string]any{"recipients": emails}
			} else {
				body["config"] = map[string]any{"url": urlStr}
			}
			if len(projects) > 0 {
				body["projectIds"] = projects
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, notifyChannelPath(orgID, ""), body, &raw); err != nil {
				return err
			}
			output.Successf("created channel %s (%s)", name, str(raw["id"]))
			if secret := str(raw["webhookSecret"]); secret != "" {
				output.Warnf("webhook signing secret (shown only once): %s", secret)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&typ, "type", "", "channel type: discord|slack|webhook|email (required)")
	c.Flags().StringVar(&name, "name", "", "channel name, 1-100 characters (required)")
	c.Flags().StringVar(&urlStr, "url", "", "webhook URL (discord/slack/webhook channels)")
	c.Flags().StringSliceVar(&emails, "email", nil, "recipient email, must be an org member (email channels, repeatable)")
	c.Flags().StringSliceVar(&events, "events", nil, "events to deliver, comma-separated (required)")
	c.Flags().StringSliceVar(&projects, "project", nil, "limit the channel to a project id (repeatable; default all projects)")
	_ = c.MarkFlagRequired("type")
	_ = c.MarkFlagRequired("name")
	_ = c.MarkFlagRequired("events")
	return c
}

func notifyChannelUpdateCmd() *cobra.Command {
	var name, urlStr string
	var emails, events, projects []string
	var allProjects, enabled, disabled bool
	c := &cobra.Command{
		Use:   "update <channelId>",
		Short: "Update a notification channel",
		Long: "Update a channel. Only the flags you pass change; the channel type is\n" +
			"fixed at creation. --project replaces the project scope, --all-projects\n" +
			"clears it, and --enabled/--disabled pause or resume delivery.\n\n" +
			notifyEventsHelp,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f := cmd.Flags()
			body := map[string]any{}
			if f.Changed("name") {
				body["name"] = name
			}
			if f.Changed("url") {
				body["config"] = map[string]any{"url": urlStr}
			}
			if f.Changed("email") {
				body["config"] = map[string]any{"recipients": emails}
			}
			if f.Changed("events") {
				if err := notifyValidateEvents(events); err != nil {
					return err
				}
				body["events"] = events
			}
			if f.Changed("project") {
				body["projectIds"] = projects
			}
			if allProjects {
				body["projectIds"] = nil
			}
			if enabled {
				body["enabled"] = true
			}
			if disabled {
				body["enabled"] = false
			}
			if len(body) == 0 {
				return errors.New("nothing to update: pass --name, --url, --email, --events, --project, --all-projects, --enabled or --disabled")
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, notifyChannelPath(orgID, args[0]), body, &raw); err != nil {
				return err
			}
			output.Successf("updated channel %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "new channel name")
	c.Flags().StringVar(&urlStr, "url", "", "new webhook URL (discord/slack/webhook channels)")
	c.Flags().StringSliceVar(&emails, "email", nil, "replace the recipient list (email channels, repeatable)")
	c.Flags().StringSliceVar(&events, "events", nil, "replace the delivered events, comma-separated")
	c.Flags().StringSliceVar(&projects, "project", nil, "replace the project scope with these project ids (repeatable)")
	c.Flags().BoolVar(&allProjects, "all-projects", false, "clear the project scope (fire for every project)")
	c.Flags().BoolVar(&enabled, "enabled", false, "resume delivery")
	c.Flags().BoolVar(&disabled, "disabled", false, "pause delivery")
	c.MarkFlagsMutuallyExclusive("url", "email")
	c.MarkFlagsMutuallyExclusive("project", "all-projects")
	c.MarkFlagsMutuallyExclusive("enabled", "disabled")
	return c
}

func notifyChannelDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <channelId>",
		Aliases: []string{"rm"},
		Short:   "Delete a notification channel and its delivery history",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("permanently delete notification channel %s", args[0]), yesFlag); err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, notifyChannelPath(orgID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted channel %s", args[0])
			return nil
		},
	}
}

func notifyChannelTestCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "test <channelId>",
		Short: "Send a test notification through a channel",
		Long: "Sends a sample deploy.succeeded notification through the channel and\n" +
			"records the attempt in the delivery log. The server throttles this\n" +
			"endpoint to 10 test sends per 60 seconds.",
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
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, notifyChannelPath(orgID, args[0], "test"), nil, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			}
			if ok, _ := raw["success"].(bool); !ok {
				msg := str(raw["error"])
				if msg == "" {
					msg = "unknown error"
				}
				return fmt.Errorf("test delivery failed: %s", msg)
			}
			output.Successf("test notification sent via channel %s", args[0])
			return nil
		},
	}
}

func notifyDeliveriesCmd() *cobra.Command {
	var limit int
	c := &cobra.Command{
		Use:   "deliveries <channelId>",
		Short: "List a channel's recent delivery attempts, newest first",
		Long: "The server retains deliveries for 30 days and returns at most the 30\n" +
			"most recent; --limit only trims that list further.",
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
			var raw any
			if err := cl.GetJSON(cmd.Context(), notifyChannelPath(orgID, args[0], "deliveries"), &raw); err != nil {
				return err
			}
			list := asList(raw)
			trimmed := false
			if limit > 0 && len(list) > limit {
				list, trimmed = list[:limit], true
			}
			if fmtFlag() == output.FormatJSON {
				if trimmed {
					return output.JSON(list)
				}
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, d := range list {
				rows = append(rows, []string{
					pick(d, "createdAt"),
					pick(d, "event"),
					output.Status(pick(d, "status")),
					pick(d, "error"),
				})
			}
			output.Table([]string{"created", "event", "status", "error"}, rows)
			return nil
		},
	}
	c.Flags().IntVar(&limit, "limit", 30, "show at most this many deliveries")
	return c
}
