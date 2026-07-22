package cmd

import (
	"errors"
	"net/url"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/exitcode"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func openCmd() *cobra.Command {
	var dash bool
	c := &cobra.Command{
		Use:     "open [deployment-id]",
		GroupID: groupCore,
		Short:   "Open a deployment's URL in your browser",
		Long: `Open a deployment's public URL in your default browser.

Without an argument the current project scope is used: if exactly one
deployment there has a URL it opens directly, otherwise the candidates are
listed. Pass --dash to open the deployment's dashboard page instead.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}

			var raw map[string]any
			if len(args) == 1 {
				if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &raw); err != nil {
					return err
				}
			} else {
				scope := scopedProject(cfg)
				if scope == "" {
					return &exitcode.UsageError{Err: errors.New("pass a deployment id or set a project first: orchard use project <slug>")}
				}
				proj, rerr := resolveProject(cmd.Context(), cl, scope)
				if rerr != nil {
					return rerr
				}
				var list any
				if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(str(proj["id"]))+"/deployments", &list); err != nil {
					return err
				}
				withURL := []map[string]any{}
				for _, d := range asList(list) {
					if firstIngressHost(d) != "" {
						withURL = append(withURL, d)
					}
				}
				switch len(withURL) {
				case 0:
					return errors.New("no deployment in this project has a URL yet")
				case 1:
					if err := cl.GetJSON(cmd.Context(), deployPath(str(withURL[0]["id"])), &raw); err != nil {
						return err
					}
				default:
					names := make([]string, 0, len(withURL))
					for _, d := range withURL {
						names = append(names, str(d["name"])+" ("+str(d["id"])+")")
					}
					return &exitcode.UsageError{Err: errors.New("multiple deployments have URLs, pass one: " + strings.Join(names, ", "))}
				}
			}

			target := ""
			if dash {
				slug := orgSlugOf(raw)
				if slug == "" {
					return errors.New("could not resolve the organization for the dashboard URL")
				}
				target = strings.TrimRight(cfg.APIURL, "/") + "/" + slug + "/deployments/" + str(raw["id"])
			} else {
				host := firstIngressHost(raw)
				if host == "" {
					return errors.New("this deployment has no URL; add a domain in the Network tab or recreate with --auto-url")
				}
				target = "https://" + host
			}

			output.Successf("opening %s", target)
			return api.OpenBrowser(target)
		},
	}
	c.Flags().BoolVar(&dash, "dash", false, "open the deployment's dashboard page instead of the app URL")
	return c
}
