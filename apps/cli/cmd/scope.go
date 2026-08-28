package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
)

// Scope precedence: flag > env var > directory link (.orchard/project.json)
// > `orchard use` context. The raw value may be an id or a slug/name;
// resolve* turns it into an id via the slug lookup endpoints, falling back to
// treating it as an id.

var (
	dirLinkOnce    sync.Once
	dirLinkVal     *config.Link
	linkNoticeOnce sync.Once
)

func dirLink() *config.Link {
	dirLinkOnce.Do(func() {
		cwd, err := os.Getwd()
		if err != nil {
			return
		}
		if l, _, ok := config.FindLink(cwd); ok {
			dirLinkVal = l
		}
	})
	return dirLinkVal
}

// linkNotice tells interactive users where their scope came from, once per
// invocation. Silent in JSON mode so piped output stays parseable.
func linkNotice(kind, label string) {
	linkNoticeOnce.Do(func() {
		if fmtFlag() == output.FormatJSON || !output.StderrIsTTY() {
			return
		}
		fmt.Fprintln(os.Stderr, output.Dim("· "+kind+" "+label+" from .orchard/project.json"))
	})
}

func scopedOrg(cfg *config.Config) string {
	if orgFlag != "" {
		return orgFlag
	}
	if v := os.Getenv("ORCHARD_ORG"); v != "" {
		return v
	}
	if l := dirLink(); l != nil && l.OrgID != "" {
		label := l.OrgSlug
		if label == "" {
			label = l.OrgID
		}
		linkNotice("org", label)
		return l.OrgID
	}
	return cfg.Context.OrgID
}

func scopedProject(cfg *config.Config) string {
	if projectFlag != "" {
		return projectFlag
	}
	if v := os.Getenv("ORCHARD_PROJECT"); v != "" {
		return v
	}
	if l := dirLink(); l != nil && l.ProjectID != "" {
		label := l.ProjectSlug
		if label == "" {
			label = l.ProjectID
		}
		linkNotice("project", label)
		return l.ProjectID
	}
	return cfg.Context.ProjectID
}

func scopedEnv(cfg *config.Config) string {
	if envFlag != "" {
		return envFlag
	}
	if v := os.Getenv("ORCHARD_ENV"); v != "" {
		return v
	}
	if l := dirLink(); l != nil && l.EnvID != "" {
		label := l.EnvName
		if label == "" {
			label = l.EnvID
		}
		linkNotice("env", label)
		return l.EnvID
	}
	return cfg.Context.EnvID
}

// requireProject resolves the project scope or explains how to set one.
func requireProject(ctx context.Context, cl *api.Client, cfg *config.Config) (string, error) {
	v := scopedProject(cfg)
	if v == "" {
		return "", errors.New("no project scope: pass --project or run `orchard use project <slug>`")
	}
	m, err := resolveProject(ctx, cl, v)
	if err != nil {
		return "", err
	}
	return str(m["id"]), nil
}

func requireOrg(ctx context.Context, cl *api.Client, cfg *config.Config) (string, error) {
	v := scopedOrg(cfg)
	if v == "" {
		return "", errors.New("no org scope: pass --org or run `orchard use org <slug>`")
	}
	m, err := resolveOrg(ctx, cl, v)
	if err != nil {
		return "", err
	}
	return str(m["id"]), nil
}

func resolveOrg(ctx context.Context, cl *api.Client, v string) (map[string]any, error) {
	var m map[string]any
	if err := cl.GetJSON(ctx, "/organizations/slug/"+url.PathEscape(v), &m); err == nil && str(m["id"]) != "" {
		return m, nil
	}
	if err := cl.GetJSON(ctx, "/organizations/"+url.PathEscape(v), &m); err != nil {
		return nil, fmt.Errorf("organization %q not found by slug or id: %w", v, err)
	}
	return m, nil
}

func resolveProject(ctx context.Context, cl *api.Client, v string) (map[string]any, error) {
	var m map[string]any
	if err := cl.GetJSON(ctx, "/projects/slug/"+url.PathEscape(v), &m); err == nil && str(m["id"]) != "" {
		return m, nil
	}
	if err := cl.GetJSON(ctx, "/projects/"+url.PathEscape(v), &m); err != nil {
		return nil, fmt.Errorf("project %q not found by slug or id: %w", v, err)
	}
	return m, nil
}

// resolveEnv matches an environment by id or name within a project.
func resolveEnv(ctx context.Context, cl *api.Client, projectID, v string) (map[string]any, error) {
	var raw any
	if err := cl.GetJSON(ctx, "/projects/"+url.PathEscape(projectID)+"/environments", &raw); err != nil {
		return nil, err
	}
	for _, e := range asList(raw) {
		if str(e["id"]) == v || strings.EqualFold(str(e["name"]), v) || strings.EqualFold(str(e["slug"]), v) {
			return e, nil
		}
	}
	return nil, fmt.Errorf("environment %q not found in project", v)
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
