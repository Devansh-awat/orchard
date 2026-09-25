package cmd

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func statusPageCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "status-page",
		GroupID: groupResources,
		Aliases: []string{"status-pages", "statuspage"},
		Short:   "Public status pages for an org",
	}
	c.AddCommand(
		statusPageListCmd(),
		statusPageShowCmd(),
		statusPageOptionsCmd(),
		statusPageCreateCmd(),
		statusPageUpdateCmd(),
		statusPageDeleteCmd(),
	)
	return c
}

func statusPagePath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/status-pages"
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func statusPageListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the org's status pages",
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
			if err := cl.GetJSON(cmd.Context(), statusPagePath(orgID), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, p := range asList(raw) {
				where := "/status/" + pick(p, "slug")
				if h := pick(p, "host"); h != "" {
					where = h
				}
				visibility := "public"
				if v, ok := p["isPublic"].(bool); ok && !v {
					visibility = "private"
				}
				rows = append(rows, []string{pick(p, "id"), pick(p, "title"), where, orDashStr(pick(p, "slug")), visibility})
			}
			output.Table([]string{"id", "title", "url", "slug", "visibility"}, rows)
			return nil
		},
	}
}

func statusPageShowCmd() *cobra.Command {
	var host string
	c := &cobra.Command{
		Use:   "show [slug]",
		Short: "Read a public status page the way a visitor does",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			slug := ""
			if len(args) == 1 {
				slug = args[0]
			}
			if slug == "" && host != "" {
				var resolved map[string]any
				if err := cl.GetJSON(cmd.Context(), "/status/resolve?host="+url.QueryEscape(host), &resolved); err != nil {
					return err
				}
				slug = pick(resolved, "slug")
			}
			if slug == "" {
				return errors.New("pass a slug or --host")
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/status/"+url.PathEscape(slug), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"title", pick(raw, "title")},
				{"overall", output.Status(pick(raw, "overall"))},
				{"checked", pick(raw, "updatedAt")},
			})
			rows := [][]string{}
			for _, c := range asList(raw["components"]) {
				rows = append(rows, []string{pick(c, "name"), output.Status(pick(c, "status")), orDashStr(pick(c, "detail")), pick(c, "uptime") + "%"})
			}
			output.Table([]string{"component", "status", "detail", "30d uptime"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&host, "host", "", "resolve the page from its host instead of a slug")
	return c
}

func statusPageOptionsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "options",
		Short: "Apps and databases a page can list",
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
			if err := cl.GetJSON(cmd.Context(), statusPagePath(orgID, "options"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, o := range asList(raw) {
				rows = append(rows, []string{pick(o, "kind") + ":" + pick(o, "resourceId"), pick(o, "name"), pick(o, "project")})
			}
			output.Table([]string{"component", "name", "project"}, rows)
			return nil
		},
	}
}

func statusPageComponents(specs []string) []map[string]any {
	out := []map[string]any{}
	for _, s := range specs {
		kind, id, ok := strings.Cut(s, ":")
		if !ok {
			continue
		}
		out = append(out, map[string]any{"kind": kind, "resourceId": id})
	}
	return out
}

func statusPageCreateCmd() *cobra.Command {
	var title, slug, description, subdomain string
	var private bool
	var components []string
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a page: --title 'Acme status' --slug acme --component deployment:<id>",
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
			body := map[string]any{"isPublic": !private, "components": statusPageComponents(components)}
			if title != "" {
				body["title"] = title
			}
			if slug != "" {
				body["slug"] = slug
			}
			if description != "" {
				body["description"] = description
			}
			if subdomain != "" {
				body["subdomain"] = subdomain
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, statusPagePath(orgID), body, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			where := "/status/" + pick(raw, "slug")
			if h := pick(raw, "host"); h != "" {
				where = h
			}
			output.Successf("created status page %s at %s", pick(raw, "id"), where)
			return nil
		},
	}
	c.Flags().StringVar(&title, "title", "", "page title (default: '<org> status')")
	c.Flags().StringVar(&slug, "slug", "", "path slug (default: the org slug)")
	c.Flags().StringVar(&description, "description", "", "one line under the title")
	c.Flags().StringVar(&subdomain, "subdomain", "", "host under the platform domain")
	c.Flags().BoolVar(&private, "private", false, "create hidden; nothing renders until it is public")
	c.Flags().StringSliceVar(&components, "component", nil, "deployment:<id> or database:<id>, in order (repeatable)")
	return c
}

func statusPageUpdateCmd() *cobra.Command {
	var title, slug, description, subdomain string
	var public, private, clearHost bool
	var components []string
	c := &cobra.Command{
		Use:   "update <pageId>",
		Short: "Change a page's title, slug, host, visibility or components",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if public && private {
				return errors.New("pass --public or --private, not both")
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
			if cmd.Flags().Changed("title") {
				body["title"] = title
			}
			if cmd.Flags().Changed("slug") {
				body["slug"] = slug
			}
			if cmd.Flags().Changed("description") {
				body["description"] = description
			}
			if clearHost {
				body["subdomain"] = nil
			} else if cmd.Flags().Changed("subdomain") {
				body["subdomain"] = subdomain
			}
			if public {
				body["isPublic"] = true
			}
			if private {
				body["isPublic"] = false
			}
			if cmd.Flags().Changed("component") {
				body["components"] = statusPageComponents(components)
			}
			if len(body) == 0 {
				return errors.New("nothing to change")
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, statusPagePath(orgID, args[0]), body, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("updated status page %s", pick(raw, "id"))
			return nil
		},
	}
	c.Flags().StringVar(&title, "title", "", "new title")
	c.Flags().StringVar(&slug, "slug", "", "new slug")
	c.Flags().StringVar(&description, "description", "", "new description")
	c.Flags().StringVar(&subdomain, "subdomain", "", "new host under the platform domain")
	c.Flags().BoolVar(&clearHost, "no-subdomain", false, "remove the host")
	c.Flags().BoolVar(&public, "public", false, "make the page public")
	c.Flags().BoolVar(&private, "private", false, "hide the page")
	c.Flags().StringSliceVar(&components, "component", nil, "replace the components with deployment:<id> or database:<id> (repeatable)")
	return c
}

func statusPageDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <pageId>",
		Aliases: []string{"rm"},
		Short:   "Delete a page and its host",
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
			if err := cl.Send(cmd.Context(), http.MethodDelete, statusPagePath(orgID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted status page %s", args[0])
			return nil
		},
	}
}
