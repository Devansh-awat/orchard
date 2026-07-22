package cmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/config"
	"github.com/LeafdTK/leaf/cli/internal/exitcode"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func linkCmd() *cobra.Command {
	var status, noGitignore bool
	c := &cobra.Command{
		Use:     "link",
		GroupID: groupCore,
		Short:   "Link this directory to an Orchard project",
		Long: "Writes .orchard/project.json so commands run from this directory (or below)\n" +
			"target the linked project without --project flags or a global `orchard use`\n" +
			"context. Resolution order: flags > ORCHARD_* env vars > directory link >\n" +
			"`orchard use`. The link stores ids and slugs only, never a token.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}

			if status {
				l, dir, ok := config.FindLink(cwd)
				if !ok {
					if fmtFlag() == output.FormatJSON {
						return output.JSON(map[string]any{"linked": false})
					}
					output.Warnf("no link found (checked up to the repo root)")
					return nil
				}
				if fmtFlag() == output.FormatJSON {
					return output.JSON(map[string]any{"linked": true, "dir": dir, "link": l})
				}
				output.KV([][2]string{
					{"file", config.LinkPath(dir)},
					{"org", labeled(l.OrgSlug, l.OrgID)},
					{"project", labeled(l.ProjectSlug, l.ProjectID)},
					{"env", labeled(l.EnvName, l.EnvID)},
				})
				return nil
			}

			cl, cfg, err := client()
			if err != nil {
				return err
			}
			scope := scopedProject(cfg)
			if scope == "" {
				return &exitcode.UsageError{Err: errors.New("tell me which project to link: orchard link --project <slug>")}
			}
			proj, err := resolveProject(cmd.Context(), cl, scope)
			if err != nil {
				return err
			}

			l := &config.Link{
				ProjectID:   str(proj["id"]),
				ProjectSlug: str(proj["slug"]),
				OrgID:       str(proj["organizationId"]),
			}
			if l.OrgID != "" {
				if org, oerr := resolveOrg(cmd.Context(), cl, l.OrgID); oerr == nil {
					l.OrgSlug = str(org["slug"])
				}
			}
			if envFlag != "" {
				env, eerr := resolveEnv(cmd.Context(), cl, l.ProjectID, envFlag)
				if eerr != nil {
					return eerr
				}
				l.EnvID, l.EnvName = str(env["id"]), str(env["name"])
			}

			p, err := config.WriteLink(cwd, l)
			if err != nil {
				return err
			}
			output.Successf("linked %s to project %s", cwd, labeled(l.ProjectSlug, l.ProjectID))
			output.Warnf("wrote %s", p)

			if !noGitignore {
				if note := ensureGitignored(cwd, ".orchard/"); note != "" {
					output.Warnf("%s", note)
				}
			}
			return nil
		},
	}
	c.Flags().BoolVar(&status, "status", false, "show the link in effect for this directory")
	c.Flags().BoolVar(&noGitignore, "no-gitignore", false, "skip adding .orchard/ to the repo .gitignore")
	return c
}

func unlinkCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "unlink",
		GroupID: groupCore,
		Short:   "Remove the directory link created by `orchard link`",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			_, dir, ok := config.FindLink(cwd)
			if !ok {
				output.Warnf("no link found (checked up to the repo root)")
				return nil
			}
			if err := config.RemoveLink(dir); err != nil {
				return err
			}
			output.Successf("removed %s", config.LinkPath(dir))
			return nil
		},
	}
}

// ensureGitignored appends pattern to the repo root .gitignore unless an
// equivalent line already covers it. Returns a human note describing what
// happened ("" when nothing needed doing or there is no repo).
func ensureGitignored(start, pattern string) string {
	root := start
	for {
		if _, err := os.Stat(filepath.Join(root, ".git")); err == nil {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			return ""
		}
		root = parent
	}

	bare := strings.Trim(pattern, "/")
	giPath := filepath.Join(root, ".gitignore")
	data, _ := os.ReadFile(giPath)
	for line := range strings.Lines(string(data)) {
		switch strings.TrimSpace(line) {
		case bare, bare + "/", "/" + bare, "/" + bare + "/":
			return ""
		}
	}

	f, err := os.OpenFile(giPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return "could not update " + giPath + ": " + err.Error()
	}
	defer f.Close()
	prefix := ""
	if len(data) > 0 && data[len(data)-1] != '\n' {
		prefix = "\n"
	}
	if _, err := fmt.Fprint(f, prefix+pattern+"\n"); err != nil {
		return "could not update " + giPath + ": " + err.Error()
	}
	return "added " + pattern + " to " + giPath
}
