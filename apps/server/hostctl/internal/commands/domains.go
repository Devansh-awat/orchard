package commands

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	appDomainPath      = "gateway.http.appDomain"
	appDomainEnv       = "APP_DOMAIN"
	publicAppDomainEnv = "PUBLIC_APP_DOMAIN"
	installModeEnv     = "INSTALL_INGRESS_MODE"
	letsEncryptIssuer  = "letsencrypt"
)

func installMode(values *cli.Values) string {
	if mode := values.EnvValue(serverEnvPath, installModeEnv); mode != "" {
		return mode
	}
	if tls, _ := values.Get("ingress.tls.enabled").(bool); tls {
		return "public"
	}
	front := values.EnvValue(serverEnvPath, "FRONTEND_URL")
	switch {
	case strings.HasPrefix(front, "https://"):
		return "tunnel"
	case strings.HasPrefix(front, "http://"):
		return "lan"
	}
	return ""
}

func retrofitInstallMode(values *cli.Values) []string {
	if values.EnvValue(serverEnvPath, installModeEnv) != "" {
		return nil
	}
	mode := installMode(values)
	if mode == "" {
		return nil
	}
	values.SetEnv(serverEnvPath, installModeEnv, mode)
	return []string{installModeEnv + " = " + mode + " (tells the dashboard this host uses orchardctl)"}
}

func isDomainName(name string) bool {
	return net.ParseIP(name) == nil && strings.Contains(strings.Trim(name, "."), ".")
}

func dnsAdvice(values *cli.Values, name string) string {
	if strings.HasSuffix(name, ".sslip.io") {
		return "sslip.io answers for " + name + ", so it needs no DNS record."
	}
	switch installMode(values) {
	case "tunnel":
		return "Add " + name + " as a public hostname on your Cloudflare Tunnel."
	case "lan":
		return "Make sure " + name + " resolves on your network."
	}
	return "Point an A record for " + name + " at this server. The certificate issues once it resolves."
}

func cleanAppDomain(raw string) (string, error) {
	cleaned := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(raw), "*"), ".")
	name, err := cleanHostname(cleaned)
	if err != nil {
		return "", err
	}
	name = strings.ToLower(name)
	if !isDomainName(name) {
		return "", fmt.Errorf("%s is not a domain. Use a name such as apps.example.com", name)
	}
	return name, nil
}

func currentAppDomain(values *cli.Values) string {
	if domain := values.EnvValue(serverEnvPath, appDomainEnv); domain != "" {
		return domain
	}
	domain, _ := values.Get(appDomainPath).(string)
	return domain
}

func setAppDomain(values *cli.Values, name string) error {
	if err := values.Put(appDomainPath, name); err != nil {
		return err
	}
	values.SetEnv(serverEnvPath, appDomainEnv, name)
	values.UnsetEnv("frontend.env", publicAppDomainEnv)
	return nil
}

func coveredByWildcard(host, domain string) bool {
	label, ok := strings.CutSuffix(host, "."+domain)
	return ok && domain != "" && label != "" && !strings.Contains(label, ".")
}

func wildcardOverride(values *cli.Values) string {
	if pinned := values.EnvValue(serverEnvPath, "PLATFORM_WILDCARD_DOMAINS"); pinned != "" {
		return "PLATFORM_WILDCARD_DOMAINS"
	}
	if pinned, _ := values.Get("tenant.wildcardDomains").(string); pinned != "" {
		return "tenant.wildcardDomains"
	}
	return ""
}

func AppsDomain() *cli.Command {
	return &cli.Command{
		Name:    "apps-domain",
		Args:    "...",
		Summary: "the domain that app addresses end in",
		Root:    true,
		Usage: `orchardctl apps-domain - the domain that app addresses end in

Orchard gives a new app an address under this domain, which needs a wildcard DNS
record. It is written to the chart values and to APP_DOMAIN together.

  orchardctl apps-domain                show it
  orchardctl apps-domain set <domain>   change it

Only new apps use a new domain. Deployed apps keep their addresses, also after a
redeploy, while DNS for the old name points at this server. To move an app, add
a domain to it.

  orchardctl apps-domain set apps.example.com --apply
`,
		Run: func(c *cli.Context, args []string) error {
			args, apply := splitApply(args)

			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				return err
			}

			action := "show"
			if len(args) > 0 {
				action = args[0]
			}

			switch action {
			case "show":
				current := currentAppDomain(values)
				if current == "" {
					c.Printf("Not set, so apps get no address. Set it with:\n")
					c.Printf("  orchardctl apps-domain set <domain> --apply\n")
					return nil
				}
				c.Printf("%s\n", current)
				return nil

			case "set":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl apps-domain set <domain>")
				}
				name, err := cleanAppDomain(args[1])
				if err != nil {
					return err
				}
				previous := currentAppDomain(values)
				if name == previous {
					return fmt.Errorf("%s is already the apps domain", name)
				}
				if err := setAppDomain(values, name); err != nil {
					return err
				}
				if err := values.Save(); err != nil {
					return err
				}

				if previous == "" {
					c.Printf("Apps domain is now %s.\n", name)
				} else {
					c.Printf("Apps domain moves from %s to %s. Only new apps use it.\n", previous, name)
					c.Printf("Deployed apps keep their addresses, also after a redeploy, while DNS for the old name points here.\n")
					c.Printf("To move an app, add a domain to it.\n")
				}
				if strings.HasSuffix(name, ".sslip.io") {
					c.Printf("%s\n", dnsAdvice(values, name))
				} else {
					c.Printf("%s\n", dnsAdvice(values, "*."+name))
				}
				if override := wildcardOverride(values); override != "" {
					c.Printf("%s is also set and takes priority. Change it too, or new apps keep the old domain.\n", override)
				}
				if mcp, _ := values.Get(mcpHostPath).(string); coveredByWildcard(mcp, previous) {
					c.Printf("The MCP endpoint stays at %s. To move it, run: orchardctl mcp enable mcp.%s --apply\n", mcp, name)
				}
				reportPending(c, apply)

			default:
				return fmt.Errorf("unknown apps-domain command: %s", action)
			}

			return maybeApply(c, apply)
		},
	}
}

func emailProblem(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	switch {
	case !ok || local == "" || domain == "":
		return email + " is not an email address"
	case strings.ContainsAny(email, " \t\"'"):
		return email + " is not an email address"
	case !strings.Contains(domain, "."):
		return email + " needs a full domain after the @"
	}
	return ""
}

func acmeEmailPatch(email string) string {
	var value any
	if email != "" {
		value = email
	}
	raw, _ := json.Marshal(map[string]any{"spec": map[string]any{"acme": map[string]any{"email": value}}})
	return string(raw)
}

func LetsEncryptEmail() *cli.Command {
	return &cli.Command{
		Name:    "letsencrypt-email",
		Args:    "...",
		Summary: "where Let's Encrypt sends account notices",
		Root:    true,
		Usage: `orchardctl letsencrypt-email - where Let's Encrypt sends account notices

The address is on the letsencrypt ClusterIssuer, not in the chart values, so a
change takes effect right away and needs no update. cert-manager updates the
account with Let's Encrypt. Certificates are not affected, and they issue and
renew with no address at all.

  orchardctl letsencrypt-email               show it
  orchardctl letsencrypt-email set <address> change it
  orchardctl letsencrypt-email unset         remove it

Only public mode uses Let's Encrypt.

  orchardctl letsencrypt-email set you@example.com
`,
		Run: func(c *cli.Context, args []string) error {
			args, _ = splitApply(args)

			values, err := cli.LoadValues(c.Env.Values)
			if err != nil {
				return err
			}
			if mode := installMode(values); mode == "lan" || mode == "tunnel" {
				return fmt.Errorf("this instance runs in %s mode, which does not use Let's Encrypt", mode)
			}

			action := "show"
			if len(args) > 0 {
				action = args[0]
			}

			switch action {
			case "show":
				out, err := c.KubectlOut("get", "clusterissuer", letsEncryptIssuer, "-o", "jsonpath={.spec.acme.email}")
				if err != nil {
					return fmt.Errorf("could not read the %s ClusterIssuer: %w", letsEncryptIssuer, err)
				}
				if out = strings.TrimSpace(out); out == "" {
					c.Printf("Not set. Set it with:\n")
					c.Printf("  orchardctl letsencrypt-email set <address>\n")
					return nil
				}
				c.Printf("%s\n", out)
				return nil

			case "set":
				if len(args) != 2 {
					return fmt.Errorf("usage: orchardctl letsencrypt-email set <address>")
				}
				email := strings.TrimSpace(args[1])
				if problem := emailProblem(email); problem != "" {
					return fmt.Errorf("%s", problem)
				}
				if err := c.Kubectl("patch", "clusterissuer", letsEncryptIssuer, "--type=merge", "-p", acmeEmailPatch(email)); err != nil {
					return err
				}
				c.Printf("Let's Encrypt email is now %s. Certificates are not affected.\n", email)
				return nil

			case "unset":
				if err := c.Kubectl("patch", "clusterissuer", letsEncryptIssuer, "--type=merge", "-p", acmeEmailPatch("")); err != nil {
					return err
				}
				c.Printf("Let's Encrypt email removed. Certificates are not affected.\n")
				return nil
			}
			return fmt.Errorf("unknown letsencrypt-email command: %s", action)
		},
	}
}
