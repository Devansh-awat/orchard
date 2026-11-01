---
title: Finishing setup
description: The checklist on the admin overview, and how to satisfy each item.
sidebar:
  order: 3
---

A fresh instance works the moment you claim it. The checklist on
**Instance admin → Overview** is everything that is still switched off.

None of it blocks deploying. Each item turns something on, and the one marked
with a warning triangle is the one you should not leave alone.

Most of it is editable at **Instance admin → Configuration**, and takes effect
immediately without a restart.

Every item follows the same rule: **an environment variable always wins over a
value stored in the database.** Setting the matching variable locks that field
so nobody can change it from the browser, which is what you want for anything an
operator must control absolutely. A field set that way is shown greyed out and
labelled `Set by the environment`.

Secrets are encrypted at rest and never sent back to the browser. An existing
secret shows as `Unchanged`, and leaving it blank keeps what is already stored,
so changing a bucket name does not mean retyping a key.

## Connect a GitHub App

Lets Orchard deploy private repositories and rebuild when you push.

The quickest path is **Instance admin → Overview → Connect a GitHub App**, which
uses GitHub's manifest flow: you press a button, GitHub asks you to confirm, and
it hands the App's credentials back. Orchard registers the callback URL, webhook
URL and permissions for you. Nothing to copy by hand.

If you would rather register the App yourself, its **Callback URL** must be
exactly:

```
https://your-orchard-host/apiv1/github/callback
```

Orchard shows the value it expects on the same page. Getting this wrong is what
produces GitHub's `The redirect_uri is not associated with this application`
error, and it is worth checking character for character: scheme, port, and no
trailing slash.

Orchard derives that URL from `FRONTEND_URL`. If your public origin differs from
`FRONTEND_URL`, for example because a proxy terminates TLS on a different
hostname, override it:

| Variable                    | Purpose                            |
| --------------------------- | ---------------------------------- |
| `GITHUB_APP_ID`             | numeric App ID                     |
| `GITHUB_APP_SLUG`           | the App's URL slug                 |
| `GITHUB_APP_PRIVATE_KEY`    | PEM contents, `\n` for newlines    |
| `GITHUB_APP_WEBHOOK_SECRET` | webhook signing secret             |
| `GITHUB_CLIENT_ID`          | OAuth client ID                    |
| `GITHUB_CLIENT_SECRET`      | OAuth client secret                |
| `GITHUB_REDIRECT_URI`       | overrides the derived callback URL |

Set any of these and the matching field becomes read-only in the UI.

## Configure database backups

This is the warning-severity item, and the wording is literal: **until a backup
bucket is configured, managed databases have no base backup at all.** Write
ahead log archiving alone cannot restore a database that has been deleted,
because there is no base to replay onto. Checkpoints, the drop guard and
restore tests are unavailable too, and the UI says so.

On an instance from the one-command installer this item is already done: the
installer runs an S3 store inside the cluster and points backups at it. That
store is on the same machine as the databases, so it is not disaster recovery.
See [The local store on self-hosted installs](/data/backups/#the-local-store-on-self-hosted-installs)
for what it covers and how to move to real S3 or R2.

| Variable               | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `R2_BACKUP_BUCKET`     | the bucket backups are written to                     |
| `R2_ENDPOINT`          | S3 endpoint, for example the R2 or MinIO URL          |
| `R2_ACCESS_KEY_ID`     | S3-compatible access key                              |
| `R2_SECRET_ACCESS_KEY` | secret key                                            |
| `R2_REGION`            | optional, the signing region; `auto` by default       |
| `R2_ACCOUNT_ID`        | Cloudflare account ID, R2 only; derives `R2_ENDPOINT` |

The checklist counts this item done once `R2_BACKUP_BUCKET`, an endpoint
(`R2_ENDPOINT`, or `R2_ACCOUNT_ID` on R2), `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` are all set. Each is also a field under **Instance admin
→ Configuration → Object storage**, apart from `R2_REGION`, which is
environment only.

**`R2_BUCKET_NAME` is not a backup setting.** It is the general bucket for
uploads and assets, may be public, and is never used for backups. Setting it
alone leaves databases with no backups.

An organization can also bring its own bucket under **Organization settings →
Backups**, which always wins over the instance's.

On an installer host, set them with `orchardctl env`, which edits one variable
at a time and leaves the rest of the list alone:

```bash
sudo orchardctl env set R2_ENDPOINT https://<account>.r2.cloudflarestorage.com
sudo orchardctl env set R2_ACCESS_KEY_ID <key id>
sudo orchardctl env set R2_SECRET_ACCESS_KEY <secret>
sudo orchardctl env set R2_BACKUP_BUCKET my-backups --apply
```

Any S3-compatible store works. After setting these, confirm a fresh backup
appears under a database's Backups tab, then run a restore test on it. A backup
you have never seen restore is not a backup.

## Set up email

Needed for invitation emails and sign-in codes.

| Variable         | Purpose                           |
| ---------------- | --------------------------------- |
| `SMTP_HOST`      | mail server hostname              |
| `SMTP_PORT`      | usually 587                       |
| `SMTP_USER`      | username                          |
| `SMTP_PASS`      | password                          |
| `SMTP_SECURE`    | `true` for implicit TLS, port 465 |
| `SMTP_FROM`      | address mail is sent from         |
| `SMTP_FROM_NAME` | display name on outgoing mail     |

The checklist counts this item done as soon as `SMTP_HOST` is set, so set the
rest at the same time or mail will fail at send rather than at boot.

Without SMTP the product still works. Invitations become copyable links you send
yourself, and you sign in with a passkey rather than an emailed code. On a single
operator instance that is often the right choice: skip it deliberately rather
than leaving it half configured.

Passkeys need TLS, which a LAN install usually does not have. There, two host
commands cover sign-in with neither email nor certificates:

```bash
sudo orchardctl login           # a one-time link, valid ten minutes
sudo orchardctl password set    # a password on the superadmin account
```

Both are documented under [host commands](/operate/host-commands/#login). The
link is the safer of the two over plain HTTP, since it cannot be reused once
spent.

## Add an identity provider

Lets people sign in through your existing SSO instead of a passkey or emailed
code. Configure it at **Instance admin → Sign in**, or pin it with environment
variables.

| Variable                   | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `AUTH_OAUTH_CLIENT_ID`     | client ID from your IdP                                          |
| `AUTH_OAUTH_CLIENT_SECRET` | client secret                                                    |
| `AUTH_OAUTH_REDIRECT_URI`  | `https://your-orchard-host/apiv1/auth/oauth/callback`            |
| `AUTH_OAUTH_ISSUER`        | issuer URL, for discovery                                        |
| `AUTH_OAUTH_AUTHORIZE_URL` | set these three instead of an issuer if discovery is unavailable |
| `AUTH_OAUTH_TOKEN_URL`     |                                                                  |
| `AUTH_OAUTH_USERINFO_URL`  |                                                                  |
| `AUTH_OAUTH_SCOPES`        | defaults to `openid profile email`                               |
| `AUTH_OAUTH_CLAIM_ID`      | claim mapping, defaults to `sub` / `email` / `name`              |

Any OIDC provider works: Keycloak, Authentik, Dex, Okta, Google.

Keep one passkey on the superadmin account after enabling SSO. If the IdP goes
down and it is the only way in, you are locked out of your own instance.

## Set the ingress CNAME

The hostname users point their own domains at with a CNAME record.

| Variable        | Purpose                                 |
| --------------- | --------------------------------------- |
| `INGRESS_CNAME` | for example `ingress.your-orchard-host` |

Leave it unset and custom domains still work, but Orchard cannot check whether
DNS points at the cluster before issuing a certificate, so it skips validation
and people find out it was wrong when the certificate fails instead.

## Use a wildcard certificate

By default every generated app URL gets its own certificate. Let's Encrypt allows
**50 certificates per registered domain per week**, so an instance handing out
`*.apps.example.com` URLs starts failing to issue somewhere north of fifty apps,
and the limit refills slowly.

A wildcard certificate removes the ceiling: one certificate covers every
subdomain.

| Variable                        | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `PLATFORM_WILDCARD_DOMAINS`     | `.apps.example.com=wildcard-tls`, comma separated for several |
| `WILDCARD_TLS_SOURCE_NAMESPACE` | namespace holding the certificate secret                      |

The suffix before `=` is the domain, the name after it is the Kubernetes secret
holding the certificate. Without a secret name Orchard still generates URLs, but
serves them without TLS.

Wildcards require a **DNS-01** challenge, so cert-manager needs an issuer with
credentials for your DNS provider. Cloudflare, Route53, AzureDNS, Google
CloudDNS, DigitalOcean, Akamai, ACME-DNS and RFC2136 all have native support.
HTTP-01 cannot issue a wildcard.

Tenant namespaces need their own copy of the secret. Either run
[reflector](https://github.com/emberstack/kubernetes-reflector) and annotate the
source secret, or let Orchard copy it by setting `certificates.copyToTenants` in
the chart. Do not do both: two writers on the same secret will fight.

## Set a default public IP

Raw TCP and UDP ports, and publicly reachable databases, are published on an
external address. Each organization can set its own under
**Organization settings → Database**, but on an instance with one routable
address there is only ever one answer, and without a default every organization
hits _"This organization does not have a public IP configured"_ for an address
they have no way to look up.

Set it once and every organization inherits it. One that sets its own still
wins, so this is a floor, not a ceiling.

| Variable             | Purpose                    |
| -------------------- | -------------------------- |
| `PUBLIC_EXPOSURE_IP` | for example `203.0.113.10` |

On an installer-based instance the host command is easier, and it writes the
values file for you:

```bash
sudo orchardctl public-ip set 203.0.113.10 --apply
```

Unconfigured by default, because an instance with no L4 load balancer, or one
behind a Cloudflare Tunnel, has no such address. Public ports are unavailable in
tunnel mode either way, because tunnels carry HTTP only.

## Point DNS at this instance

**Instance admin → Networking** lists every hostname this instance serves, what
each one currently resolves to, and whether that is where the dashboard lives.
It is the first place to look when something is unreachable, because the usual
symptom of a missing record is not an error page. It is a certificate that never
issues: ACME's HTTP-01 challenge cannot reach a name that does not resolve, so
cert-manager retries quietly and the host stays broken.

Three kinds of name are checked:

| Name             | Why                                                                     |
| ---------------- | ----------------------------------------------------------------------- |
| the dashboard    | Where people sign in. Everything else is compared against it.           |
| `*.<app domain>` | A wildcard, so every generated app URL resolves without its own record. |
| the MCP hostname | Where agents connect, if MCP is on.                                     |

The wildcard is checked with a probe label, `orchard-dns-probe.<app domain>`,
rather than with a deployed app's hostname. A generated app URL always ends in a
six-character hash, so no deployment can ever be given that name, and resolving
it proves the wildcard record exists rather than proving one app happens to be
deployed.

**Resolves to a different address than the dashboard** is reported but never
counted as unfinished. A proxy or CDN in front of the zone hands out different
addresses per hostname quite legitimately. Only a name with **no record at all**
is treated as outstanding.

### Cloudflare Tunnel

A token-managed tunnel keeps its routing table in Cloudflare rather than in the
cluster, so by default the box cannot see, let alone change, which hostnames
reach it. Give Orchard an API token and it can:

| Field                   | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Needs **Account / Cloudflare Tunnel / Edit**, and **Zone / DNS / Edit** to create records |
| `CLOUDFLARE_ACCOUNT_ID` | Shown on the right of any Cloudflare dashboard page                                       |
| `CLOUDFLARE_TUNNEL_ID`  | Zero Trust → Networks → Tunnels, then the tunnel                                          |
| `CLOUDFLARE_ZONE_ID`    | Optional. Without it the route is added but the DNS record is left to you                 |

The Networking page then shows which of this instance's hostnames are routed
through the tunnel, and adding a missing one is a button. It writes both halves,
which is the part people get wrong by hand: an ingress rule with no CNAME is a
route nothing reaches, and a CNAME with no ingress rule is Cloudflare serving
its own error page.

The token is encrypted at rest and never sent back to the browser, and as with
every other field here, setting the environment variable locks it.

## Turn the MCP endpoint on or off

Orchard ships an MCP server so Claude and other agents can drive the instance
through the same API the dashboard uses. `install.sh` publishes it at
`mcp.<your domain>` and wires the rest: the OAuth issuer, the URL the dashboard
shows people, and the shared credential the MCP authenticates to the API with.

There are two switches, and they are not the same thing.

**The chart's `mcp.enabled`** decides whether an MCP is deployed at all. Off, the
deployment and its route go away, the server reports the feature as unavailable,
and the toggle below is pinned off because nothing is serving it.

```bash
sudo orchardctl mcp disable --apply
```

**The toggle at Instance admin → Configuration** decides whether the deployed one
answers. Off, every MCP request is refused and the setup instructions disappear
from user settings, without redeploying anything. It is on by default, including
on an instance upgrading from a release that predates it.

| Variable            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `MCP_ENABLED`       | `false` refuses every MCP request and locks the toggle        |
| `MCP_BASE_URL`      | the public origin, used as the OAuth issuer                   |
| `MCP_SERVICE_TOKEN` | shared with the MCP process; a mismatch fails every tool call |

An instance installed before MCP was published by default has none of this. One
command adds it:

```bash
sudo orchardctl mcp enable --apply
```

Point an A record for the hostname at the box first, the same record as the UI.
The installer asks about this while you are watching: if the MCP hostname does
not resolve it offers to check again, to use a different hostname, or to leave
the MCP off for now. It never deploys an endpoint for a name that does not
exist, because that is the case that fails silently.

## When cert-manager is not installed

Orchard does not require it. If the CRDs are absent, or the service account
cannot read them, the certificate step reports **No certificate automation** and
setup continues. Terminate TLS wherever you already do, at your load balancer or
proxy, and ignore the wildcard item.

## Using your own registry

If you are changing which registry Orchard pushes to, or installing Orchard into
a cluster that already has one, tell the builders where it is. This is a setup
step, not a troubleshooting one: get it wrong and builds compile fine and then
fail at the push.

Builders run under a network policy that allows DNS and public IPs on ports 80
and 443, and nothing else. That is deliberate. A build runs untrusted code out
of somebody's repository, so it must not be able to reach the Orchard API, the
database, or another tenant's workloads. The cost of that is that a registry
inside the cluster, or on a private address, has to be named before a push can
reach it.

The defaults describe this project's own cluster: Harbor in a `harbor`
namespace, behind an HAProxy load balancer. Replace them with yours.

```yaml
builders:
  registryEgress:
    - namespace: orchard
      podLabels:
        app: zot
      ports:
        - port: 5000
```

`namespace` is required. `podLabels` and `ports` are optional, and leaving them
out widens the rule to the whole namespace on every port, so prefer being
specific. Find the labels your registry's pods actually carry with:

```bash
kubectl -n <registry-namespace> get pods --show-labels
```

On an installer-built host you do not have to edit the file by hand:

```bash
sudo orchardctl registry                 # what builds can reach today
sudo orchardctl registry zot --apply     # the registry install.sh ships
sudo orchardctl registry allow my-registry --label app=registry --port 5000 --apply
```

Fresh installs get the bundled registry allowed automatically. The commands are
for changing it afterwards, or for hosts installed before this existed.

### Which shape you need

| Where your registry runs                        | What to add                                        |
| ----------------------------------------------- | -------------------------------------------------- |
| In the cluster, its own namespace               | that namespace, plus the port it listens on        |
| In the cluster, next to Orchard                 | the release namespace, narrowed with `podLabels`   |
| A public registry (ghcr.io, Docker Hub, ECR)    | nothing, port 443 to public IPs is already allowed |
| Outside the cluster on a private or LAN address | see below                                          |

A registry on a private address needs more than a namespace entry. The rule that
allows public egress deliberately excludes RFC1918 and link-local ranges
(`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`), so a registry on
a LAN IP is dropped even though it is "outside" the cluster. Either give it a
public hostname on 443, or add an `ipBlock` rule of your own.

### Put it in values, not in kubectl

The NetworkPolicy is managed by the chart. Patching it in place looks like it
worked and then the next `helm upgrade` silently reverts it, so builds start
failing again with nothing in the history to explain why.

### If a push is already failing

A build that succeeds and then reports `connection refused` is this rule
missing. Confirm with:

```bash
kubectl -n orchard-builders get networkpolicy builder-network-policy -o yaml
kubectl -n orchard-builders logs job/<build-job-name> -c buildkit | tail -30
```

A registry whose own logs show no request from the builder, while a `curl` from
a cluster node succeeds, is the signature. The traffic is dropped before it
arrives, so the registry has nothing to report.

## Letting the ingress controller reach apps

Every tenant namespace is default-deny, so the ingress controller has to be
named or it cannot reach the apps running there.

This matters when Orchard is installed into a cluster that already has an
ingress controller, or one whose controller is not where the defaults expect.
The default is `network,orchard`, which is where this project runs HAProxy. A
k3s cluster running Traefik wants `traefik,orchard`.

```yaml
tenant:
  ingressNamespaces: 'traefik,orchard'
```

On an installer-built host:

```bash
sudo orchardctl policies                              # what is configured
sudo orchardctl policies set traefik,orchard --apply
```

Fresh installs get Traefik's namespace automatically. The command is for
changing it afterwards, or for hosts installed before this existed.

### The symptom is a certificate, not an outage

Getting this wrong rarely looks like a dead site. It looks like a certificate
that never issues.

The ACME HTTP-01 solver runs as a pod **inside the tenant namespace**. The
controller cannot reach it, so Let's Encrypt gets a 502 instead of the
challenge token, the order stays pending, and the app keeps serving
cert-manager's temporary self-signed certificate (issued by
`CN=cert-manager.local`).

Confusingly, the site itself may work. Routes that go through Orchard's
protection proxy are reached via the `orchard` namespace, which is allowed;
only the paths the controller connects to directly are blocked.

```bash
kubectl -n <project-namespace> get networkpolicy default-deny-all -o yaml
kubectl get challenges -A
```

A challenge pending with `wrong status code '502', expected '200'` is this.

### Existing projects

Policies are written when a namespace is created, so changing this fixes new
projects and leaves existing ones broken. The server re-applies the policy to
every namespace it manages **on boot**, so deploying the change is enough.
`orchardctl policies set --apply` does both; `orchardctl policies reapply`
restarts the server on its own if you changed the value some other way.

Do not patch the policy with `kubectl`. It is labelled `orchard.my/managed=true`
and the server rewrites it.
