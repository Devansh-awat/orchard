package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func domainCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "domain",
		GroupID: groupResources,
		Aliases: []string{"ingress", "domains"},
		Short:   "Manage domains (ingresses)",
	}
	c.AddCommand(
		domainListCmd(),
		domainGetCmd(),
		domainCreateCmd(),
		domainUpdateCmd(),
		domainDeleteCmd(),
		domainProtectionCmd(),
		domainValidateDNSCmd(),
	)
	return c
}

// fetchIngress loads an ingress by id; several ingress routes are
// project-scoped and the ingress GET carries the projectId needed to build
// them.
func fetchIngress(ctx context.Context, cl *api.Client, id string) (map[string]any, error) {
	var ing map[string]any
	if err := cl.GetJSON(ctx, "/ingresses/"+url.PathEscape(id), &ing); err != nil {
		return nil, err
	}
	return ing, nil
}

func ingressTLS(m map[string]any) string {
	if pick(m, "tlsEnabled") == "true" || pick(m, "tlsSecretName") != "" {
		return "on"
	}
	return "off"
}

func ingressTarget(m map[string]any) string {
	parts := []string{}
	for _, r := range asList(m["routes"]) {
		t := pick(r, "serviceName")
		if p := pick(r, "servicePort"); p != "" {
			t += ":" + p
		}
		if path := pick(r, "path"); path != "" && path != "/" {
			t = path + " -> " + t
		}
		parts = append(parts, t)
	}
	return strings.Join(parts, ", ")
}

// expectedCNAME mirrors the frontend's PUBLIC_INGRESS_CNAME default; the
// validate-dns endpoint deliberately never echoes DNS details back.
func expectedCNAME() string {
	if v := os.Getenv("ORCHARD_INGRESS_CNAME"); v != "" {
		return v
	}
	return "your instance's ingress hostname"
}

func domainListCmd() *cobra.Command {
	var deployment string
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List domains",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			items := []map[string]any{}
			if deployment != "" {
				var dep map[string]any
				if err := cl.GetJSON(cmd.Context(), "/deployments/"+url.PathEscape(deployment), &dep); err != nil {
					return err
				}
				items = asList(dep["ingresses"])
			} else {
				projectID, err := requireProject(cmd.Context(), cl, cfg)
				if err != nil {
					return err
				}
				var proj map[string]any
				if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(projectID), &proj); err != nil {
					return err
				}
				// there is no ingress list endpoint: deployment-linked rows come
				// embedded (full detail), the top-level array covers the rest.
				seen := map[string]bool{}
				for _, d := range asList(proj["deployments"]) {
					for _, ing := range asList(d["ingresses"]) {
						seen[str(ing["id"])] = true
						items = append(items, ing)
					}
				}
				for _, ing := range asList(proj["ingresses"]) {
					if !seen[str(ing["id"])] {
						items = append(items, ing)
					}
				}
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(items)
			}
			rows := [][]string{}
			for _, m := range items {
				rows = append(rows, []string{
					pick(m, "id"),
					pick(m, "host"),
					pick(m, "path"),
					pick(m, "deploymentId"),
					ingressTLS(m),
					output.Status(pick(m, "protectionMode")),
				})
			}
			output.Table([]string{"id", "host", "path", "deployment", "tls", "protection"}, rows)
			return nil
		},
	}
	c.Flags().StringVar(&deployment, "deployment", "", "list domains of this deployment id")
	return c
}

func domainGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <ingress-id>",
		Short: "Show a domain",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			ing, err := fetchIngress(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(ing)
			}
			output.KV([][2]string{
				{"id", pick(ing, "id")},
				{"host", pick(ing, "host")},
				{"target", ingressTarget(ing)},
				{"tls", ingressTLS(ing)},
				{"protection", pick(ing, "protectionMode")},
				{"address", pick(ing, "address", "statusAddress")},
				{"deployment", pick(ing, "deploymentId")},
				{"project", pick(ing, "projectId")},
			})
			return nil
		},
	}
}

func domainCreateCmd() *cobra.Command {
	var deployment, host, path string
	var servicePort int
	var tls bool
	c := &cobra.Command{
		Use:   "create",
		Short: "Add a domain to a deployment",
		Long: "Add a domain to a deployment.\n\n" +
			"A subdomain of your instance's app domain works immediately; a custom\n" +
			"domain needs a CNAME pointed at the cluster first. Check readiness with\n" +
			"`orchard domain validate-dns <host>`.",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{
				"host":        host,
				"path":        path,
				"servicePort": servicePort,
				"tlsEnabled":  tls,
			}
			var raw any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/deployments/"+url.PathEscape(deployment)+"/ingresses", body, &raw); err != nil {
				return err
			}
			output.Successf("added %s", host)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&deployment, "deployment", "", "deployment id to route traffic to")
	c.Flags().StringVar(&host, "host", "", "fully-qualified domain name")
	c.Flags().StringVar(&path, "path", "/", "URL path prefix")
	c.Flags().IntVar(&servicePort, "service-port", 80, "service port to route to")
	c.Flags().BoolVar(&tls, "tls", true, "provision TLS for the host")
	_ = c.MarkFlagRequired("deployment")
	_ = c.MarkFlagRequired("host")
	return c
}

func domainUpdateCmd() *cobra.Command {
	var host, path, redirectTo string
	var servicePort, redirectStatus int
	var tls bool
	c := &cobra.Command{
		Use:   "update <ingress-id>",
		Short: "Update a domain's host, path, port, or TLS",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			changed := func(name string) bool { return cmd.Flags().Changed(name) }
			if !changed("host") && !changed("path") && !changed("service-port") && !changed("tls") {
				return errors.New("nothing to update: pass --host, --path, --service-port, or --tls")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			ing, err := fetchIngress(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			newHost := str(ing["host"])
			if changed("host") {
				newHost = host
			}
			var raw any
			if target := str(ing["redirectTarget"]); target != "" || changed("redirect-to") {
				body := map[string]any{"host": newHost}
				if changed("redirect-to") {
					body["redirectTarget"] = redirectTo
				}
				if changed("redirect-status") {
					body["redirectStatus"] = redirectStatus
				}
				if changed("tls") {
					body["tlsEnabled"] = tls
				}
				err = cl.Send(cmd.Context(), http.MethodPut, "/projects/"+url.PathEscape(str(ing["projectId"]))+"/ingresses/"+url.PathEscape(args[0]), body, &raw)
			} else if depID := str(ing["deploymentId"]); depID != "" {
				body := map[string]any{"host": newHost}
				if changed("path") {
					body["path"] = path
				}
				if changed("service-port") {
					body["servicePort"] = servicePort
				}
				if changed("tls") {
					body["tlsEnabled"] = tls
				}
				err = cl.Send(cmd.Context(), http.MethodPut, "/deployments/"+url.PathEscape(depID)+"/ingresses/"+url.PathEscape(args[0]), body, &raw)
			} else {
				// the project-scoped update replaces every route, so echo the
				// current ones back with the requested overrides applied.
				routes := asList(ing["routes"])
				if len(routes) > 0 {
					if changed("path") {
						routes[0]["path"] = path
					}
					if changed("service-port") {
						routes[0]["servicePort"] = servicePort
					}
				}
				tlsEnabled := ing["tlsEnabled"] == true
				if changed("tls") {
					tlsEnabled = tls
				}
				body := map[string]any{"host": newHost, "tlsEnabled": tlsEnabled, "routes": routes}
				err = cl.Send(cmd.Context(), http.MethodPut, "/projects/"+url.PathEscape(str(ing["projectId"]))+"/ingresses/"+url.PathEscape(args[0]), body, &raw)
			}
			if err != nil {
				return err
			}
			output.Successf("updated %s", newHost)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&host, "host", "", "new domain name")
	c.Flags().StringVar(&path, "path", "/", "URL path prefix")
	c.Flags().IntVar(&servicePort, "service-port", 0, "service port to route to")
	c.Flags().BoolVar(&tls, "tls", true, "provision TLS for the host")
	c.Flags().StringVar(&redirectTo, "redirect-to", "", "for a redirect domain: where it sends visitors")
	c.Flags().IntVar(&redirectStatus, "redirect-status", 0, "for a redirect domain: 301, 302, 307 or 308")
	return c
}

func domainDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <ingress-id>",
		Aliases: []string{"rm"},
		Short:   "Delete a domain",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			ing, err := fetchIngress(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			projectID := str(ing["projectId"])
			if projectID == "" {
				return fmt.Errorf("ingress %s has no project; cannot delete", args[0])
			}
			if err := output.Confirm(fmt.Sprintf("delete domain %s? traffic to it stops immediately", pick(ing, "host")), yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/projects/"+url.PathEscape(projectID)+"/ingresses/"+url.PathEscape(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted %s", pick(ing, "host"))
			return nil
		},
	}
}

func domainProtectionCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "protection",
		Short: "Control access protection on a domain",
	}
	c.AddCommand(domainProtectionGetCmd(), domainProtectionSetCmd())
	return c
}

func domainProtectionGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <ingress-id>",
		Short: "Show a domain's protection mode and bypass secret",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			ing, err := fetchIngress(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			var raw map[string]any
			path := "/projects/" + url.PathEscape(str(ing["projectId"])) + "/ingresses/" + url.PathEscape(args[0]) + "/protection"
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.KV([][2]string{
				{"mode", pick(raw, "protectionMode")},
				{"bypass secret", pick(raw, "protectionBypassSecret")},
				{"bypass header", "x-orchard-protection-bypass"},
			})
			return nil
		},
	}
}

func normalizeProtectionMode(mode string) (string, error) {
	switch strings.ToLower(mode) {
	case "none", "password", "orchard":
		return strings.ToLower(mode), nil
	case "orchard-auth":
		return "orchard", nil
	}
	return "", fmt.Errorf("invalid --mode %q: use none, password, or orchard", mode)
}

func domainProtectionSetCmd() *cobra.Command {
	var mode, password string
	c := &cobra.Command{
		Use:   "set <ingress-id>",
		Short: "Set a domain's protection mode",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			m, err := normalizeProtectionMode(mode)
			if err != nil {
				return err
			}
			if m == "password" && password == "" {
				return errors.New("password protection needs --password")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			ing, err := fetchIngress(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			body := map[string]any{"mode": m}
			if password != "" {
				body["password"] = password
			}
			var raw map[string]any
			path := "/projects/" + url.PathEscape(str(ing["projectId"])) + "/ingresses/" + url.PathEscape(args[0]) + "/protection"
			if err := cl.Send(cmd.Context(), http.MethodPut, path, body, &raw); err != nil {
				return err
			}
			output.Successf("protection on %s set to %s", pick(ing, "host"), m)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			if s := pick(raw, "protectionBypassSecret"); s != "" {
				output.KV([][2]string{
					{"bypass secret", s},
					{"bypass header", "x-orchard-protection-bypass"},
				})
			}
			return nil
		},
	}
	c.Flags().StringVar(&mode, "mode", "", "protection mode: none|password|orchard")
	c.Flags().StringVar(&password, "password", "", "password (required with --mode password)")
	_ = c.MarkFlagRequired("mode")
	return c
}

func domainValidateDNSCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "validate-dns <host>",
		Short: "Check that a domain's DNS points at the cluster",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"projectId": projectID, "domain": args[0]}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/ingresses/validate-dns", body, &raw); err != nil {
				return err
			}
			valid := raw["valid"] == true
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			} else {
				output.KV([][2]string{
					{"domain", args[0]},
					{"valid", fmt.Sprintf("%v", valid)},
					{"message", pick(raw, "message")},
					{"expected cname", expectedCNAME()},
				})
			}
			if !valid {
				return fmt.Errorf("dns for %s is not ready: point a CNAME at %s", args[0], expectedCNAME())
			}
			output.Successf("%s", pick(raw, "message"))
			return nil
		},
	}
}
