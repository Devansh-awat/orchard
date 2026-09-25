package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func alertCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "alert",
		GroupID: groupResources,
		Aliases: []string{"alerts"},
		Short:   "Threshold alerts on app metrics",
	}
	c.AddCommand(
		alertListCmd(),
		alertMetricsCmd(),
		alertStatusCmd(),
		alertCreateCmd(),
		alertUpdateCmd(),
		alertDeleteCmd(),
	)
	return c
}

func alertPath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/metric-alerts"
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func alertScopeFlags(c *cobra.Command) (project, deployment *string) {
	project = c.Flags().String("project", "", "scope to a project id")
	deployment = c.Flags().String("deployment", "", "scope to a deployment id")
	return project, deployment
}

func alertScope(project, deployment string) (string, string, error) {
	switch {
	case project != "" && deployment != "":
		return "", "", errors.New("pass --project or --deployment, not both")
	case deployment != "":
		return "deployment", deployment, nil
	case project != "":
		return "project", project, nil
	default:
		return "org", "", nil
	}
}

func alertListCmd() *cobra.Command {
	var project, deployment *string
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List alert rules, including the ones inherited from above",
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
			scopeType, scopeID, err := alertScope(*project, *deployment)
			if err != nil {
				return err
			}
			q := url.Values{"scopeType": {scopeType}}
			if scopeID != "" {
				q.Set("scopeId", scopeID)
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), alertPath(orgID)+"?"+q.Encode(), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, r := range asList(raw) {
				where := pick(r, "scopeType")
				if id := pick(r, "scopeId"); id != "" {
					where += " " + id
				}
				from := ""
				if inh, _ := r["inherited"].(bool); inh {
					from = "inherited"
				}
				state := "on"
				if en, ok := r["enabled"].(bool); ok && !en {
					state = "off"
				}
				rows = append(rows, []string{pick(r, "id"), pick(r, "description"), where, from, state})
			}
			output.Table([]string{"id", "rule", "scope", "", "enabled"}, rows)
			return nil
		},
	}
	project, deployment = alertScopeFlags(c)
	return c
}

func alertMetricsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "metrics",
		Short: "The metrics a rule can watch",
		Args:  cobra.NoArgs,
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
			if err := cl.GetJSON(cmd.Context(), alertPath(orgID, "catalogue"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, m := range asList(raw) {
				cmps := []string{}
				if list, ok := m["comparators"].([]any); ok {
					for _, c := range list {
						cmps = append(cmps, fmt.Sprint(c))
					}
				}
				needs := ""
				if b, _ := m["needsIngress"].(bool); b {
					needs = "ingress"
				}
				rows = append(rows, []string{pick(m, "id"), pick(m, "label"), pick(m, "unit"), strings.Join(cmps, ","), pick(m, "defaultThreshold"), needs})
			}
			output.Table([]string{"metric", "label", "unit", "compare", "default", "needs"}, rows)
			return nil
		},
	}
}

func alertStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <deploymentId>",
		Short: "Every rule that applies to an app and whether it is firing",
		Args:  cobra.ExactArgs(1),
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
			if err := cl.GetJSON(cmd.Context(), alertPath(orgID, "states")+"?deploymentId="+url.QueryEscape(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, s := range asList(raw) {
				rows = append(rows, []string{
					pick(s, "label"),
					output.Status(pick(s, "status")),
					orDashStr(pick(s, "valueLabel")),
					orDashStr(pick(s, "since")),
				})
			}
			if len(rows) == 0 {
				output.Warnf("no alert rules apply to this app")
				return nil
			}
			output.Table([]string{"rule", "status", "now", "since"}, rows)
			return nil
		},
	}
}

func orDashStr(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func alertCreateCmd() *cobra.Command {
	var metric, comparator string
	var threshold, minRate float64
	var forSecs int
	var project, deployment *string
	c := &cobra.Command{
		Use:   "create",
		Short: "Add a rule: --metric cpu_percent --above 85 --for 300",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			scopeType, scopeID, err := alertScope(*project, *deployment)
			if err != nil {
				return err
			}
			body := map[string]any{
				"scopeType":  scopeType,
				"metric":     metric,
				"comparator": comparator,
				"threshold":  threshold,
				"forSeconds": forSecs,
			}
			if scopeID != "" {
				body["scopeId"] = scopeID
			}
			if cmd.Flags().Changed("min-request-rate") {
				body["minRequestRate"] = minRate
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, alertPath(orgID), body, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("created alert %s: %s", pick(raw, "id"), pick(raw, "description"))
			return nil
		},
	}
	c.Flags().StringVar(&metric, "metric", "", "metric id (see `orchard alert metrics`) (required)")
	c.Flags().StringVar(&comparator, "comparator", "gt", "gt or lt")
	c.Flags().Float64Var(&threshold, "threshold", 0, "threshold in the metric's unit (required)")
	c.Flags().IntVar(&forSecs, "for", 300, "seconds the condition must hold before it fires")
	c.Flags().Float64Var(&minRate, "min-request-rate", 0, "skip evaluation below this many requests per second (traffic metrics)")
	_ = c.MarkFlagRequired("metric")
	_ = c.MarkFlagRequired("threshold")
	project, deployment = alertScopeFlags(c)
	return c
}

func alertUpdateCmd() *cobra.Command {
	var threshold, minRate float64
	var forSecs int
	var enabled, disabled bool
	c := &cobra.Command{
		Use:   "update <ruleId>",
		Short: "Change a rule's threshold, window, or enabled state",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if enabled && disabled {
				return errors.New("pass --enabled or --disabled, not both")
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{}
			if cmd.Flags().Changed("threshold") {
				body["threshold"] = threshold
			}
			if cmd.Flags().Changed("for") {
				body["forSeconds"] = forSecs
			}
			if cmd.Flags().Changed("min-request-rate") {
				body["minRequestRate"] = minRate
			}
			if enabled {
				body["enabled"] = true
			}
			if disabled {
				body["enabled"] = false
			}
			if len(body) == 0 {
				return errors.New("nothing to change; pass --threshold, --for, --min-request-rate, --enabled or --disabled")
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, alertPath(orgID, args[0]), body, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("updated alert %s: %s", pick(raw, "id"), pick(raw, "description"))
			return nil
		},
	}
	c.Flags().Float64Var(&threshold, "threshold", 0, "new threshold")
	c.Flags().IntVar(&forSecs, "for", 0, "new window in seconds")
	c.Flags().Float64Var(&minRate, "min-request-rate", 0, "new minimum request rate")
	c.Flags().BoolVar(&enabled, "enabled", false, "turn the rule on")
	c.Flags().BoolVar(&disabled, "disabled", false, "turn the rule off")
	return c
}

func alertDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <ruleId>",
		Aliases: []string{"rm"},
		Short:   "Delete a rule",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, alertPath(orgID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted alert %s", args[0])
			return nil
		},
	}
}
