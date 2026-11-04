---
title: Finish instance setup
description: Complete the Orchard setup checklist, including the GitHub App, database backups, email, identity providers, DNS, certificates, the MCP endpoint, and registry access.
sidebar:
  order: 3
---

To turn on the optional parts of a new Orchard instance, complete the checklist at **Instance admin** > **Overview**. You can deploy apps before you finish the checklist. The backups item and the DNS item show a warning until you resolve them.

You can change most settings at **Instance admin** > **Configuration**, without a restart.

An environment variable always takes precedence over a value stored in the database. A field set by an environment variable is read-only and shows `Set by the environment`. Secrets are encrypted at rest and are not sent to the browser. A stored secret shows `Unchanged`. Leave the field blank to keep the value.

## Connect a GitHub App

A GitHub App lets Orchard deploy private repositories and rebuild when you push.

1. Go to **Instance admin** > **Overview**.
2. Select **Connect a GitHub App**.
3. Select **Create GitHub App**.
4. Confirm the creation on GitHub. Orchard registers the callback URL, webhook URL, and permissions.
5. Select **Install the App**.
6. Select the accounts whose repositories you want to deploy.

To register the GitHub App yourself, set its **Callback URL** to the following value. Orchard shows the expected value on the same page.

```txt
https://orchard.example.com/apiv1/github/callback
```

If this value is wrong, GitHub returns `The redirect_uri is not associated with this application`. Check the scheme and port, and do not add a trailing slash.

Orchard builds the URL from `FRONTEND_URL`. If your public origin is different, set `GITHUB_REDIRECT_URI`.

| Variable                    | Purpose                               |
| --------------------------- | ------------------------------------- |
| `GITHUB_APP_ID`             | The numeric GitHub App ID.                 |
| `GITHUB_APP_SLUG`           | The GitHub App's URL slug.                 |
| `GITHUB_APP_PRIVATE_KEY`    | The PEM contents, with `\n` for newlines. |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook signing secret.           |
| `GITHUB_CLIENT_ID`          | The OAuth client ID.                  |
| `GITHUB_CLIENT_SECRET`      | The OAuth client secret.              |
| `GITHUB_REDIRECT_URI`       | Overrides the derived callback URL.   |

## Configure database backups

On an installer host, backups already work. They are on this server, so if the server is lost, the backups are lost. The checklist shows **Add S3 storage for off-server backups** until you add a bucket.

On a Helm install, managed databases have no backups until you turn on the store on the server or add a bucket. Write-ahead log (WAL) archiving alone cannot restore a deleted database. Checkpoints, the drop guard, and restore tests are also unavailable.

For the steps and the settings for each provider, refer to [Add S3 storage](/operate/storage/).

An organization can use its own bucket at **Organization settings** > **Backups**. That bucket takes precedence over the instance's.

To confirm the setup, take a backup of a database, then run a restore test on it. For more information, refer to [Back up and restore a database](/data/backups/).

## Set up email

Email delivers invitations and sign-in codes. Set the values in **Instance admin** > **Configuration** > **Email**, or use the following environment variables.

| Variable         | Purpose                               |
| ---------------- | ------------------------------------- |
| `SMTP_HOST`      | The mail server hostname.             |
| `SMTP_PORT`      | The port, usually `587`.              |
| `SMTP_USER`      | The username.                         |
| `SMTP_PASS`      | The password.                         |
| `SMTP_SECURE`    | `true` for implicit TLS on port `465`. |
| `SMTP_FROM`      | The address that mail is sent from.   |
| `SMTP_FROM_NAME` | The display name on outgoing mail.    |

Set all of the values together. The checklist counts this item as done when the host is set, and mail with incomplete settings fails when it is sent.

Without email:

- Invitations are links that you copy and send yourself.
- Orchard hides email codes on the sign-in pages.
- People sign in with a passkey, an identity provider, or a password.

Passkeys need HTTPS. A LAN install usually has plain HTTP. On that install, use one of the following commands on the host:

```bash
sudo orchardctl login           # a one-time link, valid for ten minutes
sudo orchardctl password set    # a password on the superadmin account
```

Over plain HTTP, the one-time link is safer because it cannot be reused. For more information, refer to [Host commands](/operate/host-commands/#login).

## Add an identity provider

An identity provider lets people sign in through your existing SSO. To add a provider for the whole instance, go to **Instance admin** > **Sign in** and select **Add provider**. You can also use the following environment variables. Any OpenID Connect provider works.

| Variable                   | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `AUTH_OAUTH_CLIENT_ID`     | The client ID from your provider.                                  |
| `AUTH_OAUTH_CLIENT_SECRET` | The client secret.                                                 |
| `AUTH_OAUTH_REDIRECT_URI`  | `https://orchard.example.com/apiv1/auth/oauth/callback`            |
| `AUTH_OAUTH_ISSUER`        | The issuer URL, for discovery.                                     |
| `AUTH_OAUTH_AUTHORIZE_URL` | Set these three URLs instead of an issuer if discovery is unavailable. |
| `AUTH_OAUTH_TOKEN_URL`     |                                                                    |
| `AUTH_OAUTH_USERINFO_URL`  |                                                                    |
| `AUTH_OAUTH_SCOPES`        | The default is `openid profile email`.                             |
| `AUTH_OAUTH_CLAIM_ID`      | The claim for the user ID. The default is `sub`.                   |
| `AUTH_OAUTH_CLAIM_EMAIL`   | The claim for the email address. The default is `email`.           |
| `AUTH_OAUTH_CLAIM_NAME`    | The claim for the name. The default is `name`.                     |

Keep a passkey or password on the superadmin account. If the provider fails and it is your only method, you can only sign in by using `orchardctl login` on the host.

For per-organization providers, refer to [Set up SSO](/teams/sso/).

## Set the ingress CNAME

The ingress CNAME is the hostname that people point their own domains at. The installer asks for it and saves it, so you can change it at **Instance admin** > **Configuration** > **Custom domains**. The default depends on the mode. In `public` mode, it uses the dashboard domain. In `tunnel` mode, it uses `<tunnel-id>.cfargotunnel.com`. In `lan` mode, it uses an `sslip.io` name for the machine's address. On other installs, set it in **Instance admin** > **Configuration** > **Custom domains**.

In `tunnel` mode, each custom domain also needs a route in the tunnel. Cloudflare hides proxied records, so Orchard can confirm only that the hostname resolves.

Without it, custom domains still work, but Orchard does not check DNS before it requests a certificate. A wrong record then appears as a failed certificate.

## Use a wildcard certificate

By default, each generated app URL gets its own certificate. Let's Encrypt allows 50 certificates for each registered domain per week. A wildcard certificate covers every subdomain.

| Variable                        | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `PLATFORM_WILDCARD_DOMAINS`     | `.apps.example.com=wildcard-tls`, comma separated for several. |
| `WILDCARD_TLS_SOURCE_NAMESPACE` | The namespace that holds the certificate Secret.              |

Text before the `=` is the domain. Text after it is the Kubernetes Secret. Without a Secret name, Orchard still generates URLs, and each gets its own certificate.

Wildcards require a DNS-01 challenge. For the issuer and verification steps, refer to [Set up wildcard certificates](/operate/wildcard-certificates/).

## Set a default public IP

Raw TCP and UDP ports, and public databases, are published on an external address. Without a default, each organization must set its own, or it receives the following error:

```txt
This organization does not have a public IP configured
```

The installer asks for this address and saves it. The checklist lists this item only on an installer host that has no address. An organization that sets its own address at **Organization settings** > **Database defaults** overrides the default.

Set the default in **Instance admin** > **Configuration** > **Public exposure**. To pin it with `PUBLIC_EXPOSURE_IP`, which locks the field, run the following command on an installer host:

```bash
sudo orchardctl public-ip set 203.0.113.10 --apply
```

Public ports are not available in tunnel mode, because tunnels carry only HTTP.

## Point DNS at this instance

**Instance admin** > **Networking** lists each hostname that the instance serves and what it resolves to. Check this page first when something is unreachable. A missing record usually appears as a certificate that never issues, because the ACME HTTP-01 challenge cannot reach the name.

| Name             | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| The dashboard    | Where people sign in. Orchard compares other names with it. |
| `*.<app domain>` | A wildcard, so each generated app URL resolves.          |
| The MCP hostname | Where agents connect, if MCP is on.                      |

Orchard checks the wildcard with the name `orchard-dns-probe.<app domain>`.

A status of **Different address** does not count as unfinished, because a proxy or CDN can return different addresses for each hostname. A status of **No record** counts as unfinished.

### Cloudflare Tunnel

To let Orchard read and change the routes of a token-managed tunnel, enter these values in the **Cloudflare Tunnel** section of **Instance admin** > **Networking**.

| Variable                | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Needs **Account / Cloudflare Tunnel / Edit**, and **Zone / DNS / Edit** to create records. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID.                                                                |
| `CLOUDFLARE_TUNNEL_ID`  | The tunnel ID, from the tunnel's page in the Cloudflare dashboard.                        |
| `CLOUDFLARE_ZONE_ID`    | Optional. Without it, Orchard adds the route and you add the DNS record.                  |

The page then shows which hostnames are routed through the tunnel, and has a control that adds a missing route. Orchard creates the ingress rule and the CNAME record together.

## Turn the MCP endpoint on or off

Orchard includes a [Model Context Protocol (MCP) server](/mcp/) for agents. The endpoint is at the root of the hostname you gave the installer. The installer publishes it, and sets the OAuth issuer, the URL in the dashboard, and the credential that the MCP server uses to call the API.

Two settings control MCP.

**Deployment:** The chart value `mcp.enabled` decides whether an MCP server is deployed. To change it on an installer host, run one of the following commands:

```bash
sudo orchardctl mcp enable --apply
sudo orchardctl mcp disable --apply
```

The default hostname needs no DNS record of its own. For any other hostname, create an A record before you run `enable`. When the value is off, Orchard pins the toggle below to off.

**Runtime:** At **Instance admin** > **Configuration** > **Model Context Protocol**, the **Accept MCP connections** toggle decides whether a deployed server answers. When it is off, Orchard refuses every request and hides the setup page. It is on by default.

| Variable            | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `MCP_ENABLED`       | `false` refuses every MCP request and locks the toggle.          |
| `MCP_BASE_URL`      | The public origin, used as the OAuth issuer.                     |
| `MCP_SERVICE_TOKEN` | Shared with the MCP process. A mismatch makes every tool call fail. |

During installation, if the MCP hostname does not resolve, the installer offers to check again, to use a different hostname, or to leave MCP off. On a Helm install, set `mcp.ingress.host`.

## When cert-manager is not installed

Orchard does not require cert-manager. If the CRDs are absent, or the service account cannot read them, the certificate step shows **No certificate automation**. Terminate TLS at your load balancer or proxy, and ignore the wildcard item.

## Use your own registry

To change the registry that Orchard pushes to, or to install Orchard in a cluster that has a registry, tell the builders where it is. Otherwise, builds finish and then fail at the push.

A network policy limits builders to DNS and public IP addresses on ports 80 and 443. A build runs code from a repository, so it must not reach the Orchard API or database. Add a registry inside the cluster or on a private address explicitly.

The chart defaults describe the Hack Club cluster: Harbor in a `harbor` namespace and an HAProxy load balancer. Replace them with your own values.

```yaml
builders:
  registryEgress:
    - namespace: orchard
      podLabels:
        app: zot
      ports:
        - port: 5000
```

`namespace` is required. `podLabels` and `ports` are optional. Without them, the rule covers the whole namespace on every port. To find the labels on your registry's pods, run the following command:

```bash
kubectl -n <REGISTRY_NAMESPACE> get pods --show-labels
```

On an installer host, use the following commands. A new install has the bundled registry allowed already.

```bash
sudo orchardctl registry                 # show what builds can reach
sudo orchardctl registry zot --apply     # allow the registry that the installer deploys
sudo orchardctl registry allow my-registry --label app=registry --port 5000 --apply
```

| Registry location                               | What to add                                        |
| ----------------------------------------------- | -------------------------------------------------- |
| In the cluster, in its own namespace            | That namespace and the port it listens on.         |
| In the cluster, next to Orchard                 | The release namespace, narrowed with `podLabels`.  |
| A public registry, such as ghcr.io or Docker Hub | Nothing. Port 443 to public IP addresses is allowed. |
| Outside the cluster on a private address        | A public hostname on port 443, or your own `ipBlock` rule. |

The rule that allows public egress excludes `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, and `100.64/10`. A registry on a LAN address is therefore blocked.

Set these values in your values file. Do not patch the NetworkPolicy with `kubectl`, because the next `helm upgrade` reverts the change.

### If a push is already failing

A build that succeeds and then reports `connection refused` usually means that this rule is missing. To confirm, run the following commands:

```bash
kubectl -n orchard-builders get networkpolicy builder-network-policy -o yaml
kubectl -n orchard-builders logs job/<BUILD_JOB_NAME> -c buildkit --tail=30
```

If the registry's logs show no request from the builder, the policy dropped the traffic.

## Let the ingress controller reach apps

Every tenant namespace is default-deny, so the ingress controller's namespace must be listed. The default is `network,orchard`. A cluster that runs Traefik in the `traefik` namespace needs `traefik,orchard`. On k3s with its bundled Traefik, the namespace is `kube-system`.

```yaml
tenant:
  ingressNamespaces: 'traefik,orchard'
```

On an installer host, run the following commands. A new install has the Traefik namespace set already.

```bash
sudo orchardctl policies                              # show the configured namespaces
sudo orchardctl policies set traefik,orchard --apply
```

### Identify the symptom

A wrong value usually appears as a certificate that never issues. The ACME HTTP-01 solver runs as a pod in the tenant namespace. The controller cannot reach it, so Let's Encrypt receives a `502` status. The app keeps serving cert-manager's temporary certificate, issued by `CN=cert-manager.local`.

The site itself can still work, because routes through the protection proxy come from the `orchard` namespace.

To confirm, run the following commands. A challenge with `wrong status code '502', expected '200'` has this cause.

```bash
kubectl -n <PROJECT_NAMESPACE> get networkpolicy default-deny-all -o yaml
kubectl get challenges -A
```

### Existing projects

The server rewrites the policy in every namespace it manages when it starts. `orchardctl policies set --apply` applies the change and restarts the server. If you changed the value another way, run `sudo orchardctl policies reapply`.

Do not patch the policy with `kubectl`. It has the label `orchard.my/managed=true`, and the server restores it.

## Related resources

- [Go to production](/operate/production/)
- [Configuration](/operate/configuration/)
- [Host commands](/operate/host-commands/)
