package commands

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	mcpEnabledPath  = "mcp.enabled"
	mcpHostPath     = "mcp.ingress.host"
	mcpURLPath      = "mcp.url"
	mcpEnvPath      = "mcp.env"
	serverEnvPath   = "server.env"
	serviceTokenKey = "MCP_SERVICE_TOKEN"
)

// defaultMcpHost puts the MCP under the app domain, because the app wildcard
// record already covers mcp.<app domain>. An instance with no app domain falls
// back to a sibling of the UI's hostname. An operator who wants something else
// passes it explicitly.
func defaultMcpHost(appDomain, uiHost string) string {
	if appDomain = strings.TrimSpace(appDomain); appDomain != "" {
		return "mcp." + appDomain
	}
	uiHost = strings.TrimSpace(uiHost)
	if uiHost == "" {
		return ""
	}
	_, parent, ok := strings.Cut(uiHost, ".")
	if !ok || parent == "" {
		return ""
	}
	return "mcp." + parent
}

func mintToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("could not mint a service token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// wireCredentials gives the MCP the two secrets it cannot work without. Both
// are shared with the server rather than its own: JWT_SECRET signs the sessions
// both processes validate, and the service token is what the server recognises
// on the gateway path when the MCP acts for a consenting user. A mismatch is
// not a startup error, it is every tool call failing at authentication time.
func wireCredentials(values *cli.Values) error {
	jwt := values.EnvValue(serverEnvPath, "JWT_SECRET")
	if jwt == "" {
		return fmt.Errorf("server.env has no JWT_SECRET, so the MCP has nothing to validate sessions against")
	}
	values.SetEnv(mcpEnvPath, "JWT_SECRET", jwt)

	token := values.EnvValue(serverEnvPath, serviceTokenKey)
	if token == "" {
		token = values.EnvValue(mcpEnvPath, serviceTokenKey)
	}
	if token == "" {
		minted, err := mintToken()
		if err != nil {
			return err
		}
		token = minted
	}
	values.SetEnv(serverEnvPath, serviceTokenKey, token)
	values.SetEnv(mcpEnvPath, serviceTokenKey, token)
	return nil
}

// publicScheme is what a client types, which is not always what the route
// terminates. Behind a tunnel Traefik answers plaintext in-cluster while the
// world connects over https, so the server's own FRONTEND_URL is the better
// witness than the route's TLS flag.
func publicScheme(values *cli.Values) string {
	frontend := values.EnvValue(serverEnvPath, "FRONTEND_URL")
	if scheme, _, ok := strings.Cut(frontend, "://"); ok && scheme != "" {
		return scheme
	}
	if enabled, ok := values.Get("ingress.tls.enabled").(bool); ok && enabled {
		return "https"
	}
	return "http"
}

func publicMcpURL(values *cli.Values, host string) string {
	_, port := servedOn(values)
	if port != "" {
		host = net.JoinHostPort(host, port)
	}
	return fmt.Sprintf("%s://%s", publicScheme(values), host)
}

func mcpURL(values *cli.Values) string {
	if url, _ := values.Get(mcpURLPath).(string); url != "" {
		return url
	}
	host, _ := values.Get(mcpHostPath).(string)
	if host == "" {
		return ""
	}
	scheme := "http"
	if enabled, ok := values.Get("mcp.ingress.tls.enabled").(bool); ok && enabled {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, host)
}

func Mcp() *cli.Command {
	return &cli.Command{
		Name:    "mcp",
		Args:    "...",
		Summary: "the MCP endpoint agents connect to",
		Root:    true,
		Usage: `orchardctl mcp - the MCP endpoint agents connect to

Orchard's MCP server lets Claude and other agents drive this instance through
the same API the dashboard uses. It answers on its own hostname, so it needs
one before anything can connect.

  orchardctl mcp                  show whether it is on and where it answers
  orchardctl mcp enable [host]    turn it on, default mcp.<your app domain>
  orchardctl mcp disable          stop deploying it

enable also copies JWT_SECRET across from the server and mints a shared
MCP_SERVICE_TOKEN if there is not one already, because the MCP authenticates
to the API as a service and passes the consenting user along. Without both,
every tool call fails at authentication rather than at startup.

The default needs no DNS of its own: the wildcard record for your apps covers
it. For any other hostname, point an A record at this box first.

  orchardctl mcp enable mcp.example.com --apply

There is also a runtime switch in the admin panel, under Configuration, which
stops the deployed MCP from answering without redeploying anything.
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
				enabled, _ := values.Get(mcpEnabledPath).(bool)
				if !enabled {
					c.Printf("off. turn it on with: orchardctl mcp enable --apply\n")
					return nil
				}
				url := mcpURL(values)
				if url == "" {
					c.Printf("on, but no hostname is set, so nothing is routed to it.\n")
					c.Printf("run: orchardctl mcp enable <host> --apply\n")
					return nil
				}
				c.Printf("%s\n", url)
				return nil

			case "enable":
				host := ""
				if len(args) > 1 {
					host = args[1]
				}
				wasOn, _ := values.Get(mcpEnabledPath).(bool)
				previous, _ := values.Get(mcpHostPath).(string)
				if host == "" {
					host = previous
				}
				if host == "" {
					uiHost, _ := values.Get("ingress.host").(string)
					host = defaultMcpHost(values.EnvValue(serverEnvPath, "APP_DOMAIN"), uiHost)
				}
				if host == "" {
					return fmt.Errorf("no hostname to use: orchardctl mcp enable <host>")
				}

				if err := wireCredentials(values); err != nil {
					return err
				}

				for path, value := range map[string]string{
					mcpEnabledPath:        "true",
					"mcp.ingress.enabled": "true",
					mcpHostPath:           host,
					mcpURLPath:            publicMcpURL(values, host),
				} {
					if err := values.Set(path, value); err != nil {
						return err
					}
				}

				// The MCP route wants the same treatment the UI's already has:
				// a bare tls block makes Traefik answer with its self-signed
				// default certificate, which every MCP client refuses.
				if entryPoints := values.List("ingress.entryPoints"); len(entryPoints) > 0 {
					values.SetList("mcp.ingress.entryPoints", entryPoints)
				}
				tlsOn, _ := values.Get("ingress.tls.enabled").(bool)
				if err := values.Set("mcp.ingress.tls.enabled", fmt.Sprintf("%t", tlsOn)); err != nil {
					return err
				}
				if issuer, ok := values.Get("ingress.tls.issuerRef").(map[string]any); ok {
					for k, v := range issuer {
						if err := values.Set("mcp.ingress.tls.issuerRef."+k, fmt.Sprintf("%v", v)); err != nil {
							return err
						}
					}
				}

				if err := values.Save(); err != nil {
					return err
				}
				url := mcpURL(values)
				c.Printf("MCP on at %s\n", url)
				if strings.HasPrefix(url, "http://") {
					c.Printf("no TLS in front of it, so the endpoint is plain http\n")
				}
				if wasOn && previous != "" && previous != host {
					c.Printf("Agents must reconnect at the new URL.\n")
				}
				if coveredByWildcard(host, currentAppDomain(values)) {
					c.Printf("The wildcard record for your apps covers %s, so it needs no record of its own.\n", host)
				} else {
					c.Printf("%s\n", dnsAdvice(values, host))
				}
				return maybeApply(c, apply)

			case "disable":
				if err := values.Set(mcpEnabledPath, "false"); err != nil {
					return err
				}
				if err := values.Save(); err != nil {
					return err
				}
				c.Printf("MCP off. the deployment goes away on the next upgrade.\n")
				return maybeApply(c, apply)
			}

			return fmt.Errorf("unknown mcp command: %s", action)
		},
	}
}
