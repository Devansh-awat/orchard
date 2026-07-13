package cmd

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"

	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

// overviewCmd mirrors the web dashboard. Note the endpoint is keyed by org
// SLUG, not id, so the scope value is resolved to the full org first.
func overviewCmd() *cobra.Command {
	var builds bool
	c := &cobra.Command{
		Use:     "overview",
		GroupID: groupCore,
		Short:   "Org dashboard: projects, deployments, and databases at a glance",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			scope := scopedOrg(cfg)
			if scope == "" {
				return errors.New("no org scope: pass --org or run `orchard use org <slug>`")
			}
			org, err := resolveOrg(cmd.Context(), cl, scope)
			if err != nil {
				return err
			}
			slug := str(org["slug"])
			if slug == "" {
				return fmt.Errorf("organization %q has no slug", scope)
			}
			var ov map[string]any
			if err := cl.GetJSON(cmd.Context(), "/overview/orgs/"+url.PathEscape(slug), &ov); err != nil {
				return err
			}
			var feed map[string]any
			if builds {
				if err := cl.GetJSON(cmd.Context(), "/overview/orgs/"+url.PathEscape(slug)+"/builds", &feed); err != nil {
					return err
				}
			}
			if fmtFlag() == output.FormatJSON {
				if builds {
					return output.JSON(map[string]any{"overview": ov, "builds": feed})
				}
				return output.JSON(ov)
			}
			overviewRender(ov, slug)
			if builds {
				overviewRenderBuilds(feed)
			}
			return nil
		},
	}
	c.Flags().BoolVar(&builds, "builds", false, "include the recent build feed")
	return c
}

func overviewRender(ov map[string]any, slug string) {
	orgInfo, _ := ov["organization"].(map[string]any)
	deployments := asList(ov["deployments"])
	name := pick(orgInfo, "name")
	if name == "" {
		name = slug
	} else {
		name += " " + output.Dim("("+slug+")")
	}
	pairs := [][2]string{
		{"org", name},
		{"projects", strconv.Itoa(len(asList(ov["projects"])))},
		{"deployments", strconv.Itoa(len(deployments))},
		{"databases", strconv.Itoa(len(asList(ov["databases"])))},
	}
	if cm, ok := ov["currentMember"].(map[string]any); ok {
		if role := pick(cm, "role"); role != "" {
			if synthetic, _ := cm["synthetic"].(bool); synthetic {
				role += " " + output.Dim("(superadmin)")
			}
			pairs = append(pairs, [2]string{"role", role})
		}
	}
	output.KV(pairs)

	if len(deployments) == 0 {
		return
	}
	fmt.Println()
	fmt.Println(output.Dim("── deployments"))
	rows := [][]string{}
	for _, d := range deployments {
		rows = append(rows, []string{
			pick(d, "id"),
			pick(d, "name"),
			output.Status(pick(d, "status")),
			pick(quotaSub(d, "project"), "name", "slug"),
			overviewHost(d),
		})
	}
	output.Table([]string{"id", "name", "status", "project", "host"}, rows)
}

func overviewRenderBuilds(feed map[string]any) {
	fmt.Println()
	fmt.Println(output.Dim("── active builds"))
	rows := [][]string{}
	for _, d := range asList(feed["active"]) {
		rows = append(rows, []string{
			pick(d, "name"),
			pick(quotaSub(d, "project"), "name"),
			output.Status(pick(d, "buildStatus")),
			pick(d, "buildStep"),
			pick(d, "updatedAt"),
		})
	}
	output.Table([]string{"deployment", "project", "status", "step", "updated"}, rows)

	fmt.Println()
	fmt.Println(output.Dim("── recent builds"))
	rows = [][]string{}
	for _, b := range asList(feed["recent"]) {
		dep := quotaSub(b, "deployment")
		sha := pick(b, "commitSha")
		if len(sha) > 7 {
			sha = sha[:7]
		}
		rows = append(rows, []string{
			pick(dep, "name"),
			pick(quotaSub(dep, "project"), "name"),
			output.Status(pick(dep, "buildStatus")),
			pick(b, "branch"),
			sha,
			pick(b, "triggerType"),
			pick(b, "isActive"),
			pick(b, "createdAt"),
		})
	}
	output.Table([]string{"deployment", "project", "status", "branch", "commit", "trigger", "active", "created"}, rows)
}

func overviewHost(d map[string]any) string {
	for _, ing := range asList(d["ingresses"]) {
		if h := pick(ing, "host"); h != "" {
			return h
		}
	}
	return ""
}
