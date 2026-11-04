package cmd

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func auditCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "audit",
		GroupID: groupResources,
		Aliases: []string{"audit-log", "audit-logs"},
		Short:   "Inspect the audit log",
	}
	c.AddCommand(auditListCmd())
	return c
}

// auditFetch pages the audit endpoints locally: the envelope is
// {"entries": [...], "nextCursor": ...}, which fetchPaged's asList cannot
// unwrap (same approach as jobFetchRuns).
func auditFetch(ctx context.Context, cl *api.Client, path, action string, limit int, cursor string, all bool) ([]map[string]any, string, error) {
	items := []map[string]any{}
	for page := 0; ; page++ {
		if page >= maxPages {
			return items, cursor, errors.New("--all hit the 100-page safety cap")
		}
		q := url.Values{}
		if action != "" {
			q.Set("action", action)
		}
		if limit > 0 {
			q.Set("limit", strconv.Itoa(limit))
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		p := path
		if len(q) > 0 {
			p += "?" + q.Encode()
		}
		var raw map[string]any
		if err := cl.GetJSON(ctx, p, &raw); err != nil {
			return items, cursor, err
		}
		items = append(items, asList(raw["entries"])...)
		cursor = pick(raw, "nextCursor")
		if cursor == "" || !all {
			return items, cursor, nil
		}
	}
}

// auditActor prefers the resolved user, falling back to the recorded email;
// entries without either were written by the platform itself.
func auditActor(e map[string]any) string {
	if u, ok := e["actor"].(map[string]any); ok {
		if v := pick(u, "username", "email"); v != "" {
			return v
		}
		if name := strings.TrimSpace(pick(u, "firstName") + " " + pick(u, "lastName")); name != "" {
			return name
		}
	}
	if v := pick(e, "actorEmail"); v != "" {
		return v
	}
	return output.Dim("system")
}

func auditTarget(e map[string]any) string {
	label := pick(e, "targetLabel", "targetId")
	typ := pick(e, "targetType")
	switch {
	case typ != "" && label != "":
		return typ + " " + label
	case label != "":
		return label
	default:
		return typ
	}
}

func auditListCmd() *cobra.Command {
	var deployment, action string
	var limit *int
	var cursor *string
	var all *bool
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List audit log entries for the organization (or one deployment), newest first",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			var path string
			if deployment != "" {
				path = "/audit-logs/deployment/" + url.PathEscape(deployment)
			} else {
				orgID, rerr := requireOrg(cmd.Context(), cl, cfg)
				if rerr != nil {
					return rerr
				}
				path = "/audit-logs/organization/" + url.PathEscape(orgID)
			}
			entries, next, err := auditFetch(cmd.Context(), cl, path, action, *limit, *cursor, *all)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				out := map[string]any{"entries": entries}
				if next != "" {
					out["nextCursor"] = next
				}
				return output.JSON(out)
			}
			rows := [][]string{}
			for _, e := range entries {
				rows = append(rows, []string{
					pick(e, "createdAt"),
					auditActor(e),
					pick(e, "action"),
					auditTarget(e),
				})
			}
			output.Table([]string{"ts", "actor", "action", "target"}, rows)
			if next != "" {
				output.Warnf("more entries available: resume with --cursor %s", next)
			}
			return nil
		},
	}
	c.Flags().StringVar(&deployment, "deployment", "", "scope to one deployment instead of the whole organization")
	c.Flags().StringVar(&action, "action", "", "only entries with this exact action (e.g. deployment.create)")
	limit, cursor, all = addPageFlags(c)
	return c
}
