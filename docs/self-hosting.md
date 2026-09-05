# Self-hosting Orchard

Orchard deploys onto an existing Kubernetes cluster via the Helm chart in
[`infra/charts/orchard`](../infra/charts/orchard). The chart installs
Orchard's own components (frontend, API server, MCP, Redis, control-plane
Postgres, image builders, metrics stack) but **no cluster operators**: you
bring the platform layer below it.

For a laptop-sized trial run, use the quickstart instead:

```bash
./scripts/quickstart.sh
```

It creates a local k3d cluster, installs the prerequisites, and deploys the
chart with dev values.

## Cluster prerequisites

| Component | Needed for | Notes |
|---|---|---|
| [CloudNativePG](https://cloudnative-pg.io) operator | Control-plane DB and every user database | The chart only creates `Cluster` resources |
| [Traefik](https://traefik.io) with Gateway API support | Control-plane ingress (`IngressRoute`) and user app routing (`HTTPRoute` via a shared `Gateway`) | Gateway API CRDs must be installed |
| [cert-manager](https://cert-manager.io) | TLS certificates | Plus a DNS-01 `ClusterIssuer` if you want wildcard certs for the app domain (see `infra/charts/orchard/SETUP-wildcards.md`) |
| A default StorageClass | Postgres volumes, buildkit cache, Redis, metrics | Set `tenant.storageClass` / the chart `storageClass` values if it isn't the cluster default |
| An OCI registry (e.g. [Harbor](https://goharbor.io)) | Where built user images are pushed and pulled from | Configure via `DOCKER_REGISTRY_PUSH` / `DOCKER_REGISTRY_PULL` / `REGISTRY_PROJECT` server env |
| An ingress controller for tenant ingresses | Custom-domain ingresses for user apps | Class name via `tenant.ingressClass` (default `haproxy`) |
| L4 LoadBalancer (e.g. [MetalLB](https://metallb.io)) | Public database exposure and TCP/UDP passthrough | Only if you enable those features |
| gVisor / Kata RuntimeClasses | Sandboxed tenant/builder pods | Optional; Talos-specific setup in `values.yaml` |
| Datadog agent | APM/tracing | Optional; `datadog.enabled: false` turns it all off |

## ServiceAccount permissions

The chart creates the `orchard-server` ServiceAccount, the ClusterRole the
control plane needs, and a namespaced Role for the leader-election Leases.

Because tenant namespaces are created at runtime, the write grants can't be
namespaced Roles and are cluster-scoped: namespaces, pods (plus `exec` for the
web terminal), Deployments, Services, Ingresses, PVCs, NetworkPolicies, Jobs,
CronJobs, EndpointSlices, CNPG Clusters, and read/patch on nodes for the node
informer. Secrets and configmaps are deliberately *not* granted cluster-wide —
the server holds `escalate`/`bind` so it can bootstrap a narrow per-namespace
secrets Role when it creates a tenant namespace, without ever holding
cluster-wide secrets access itself.

None of this applies if you point the server at an external kubeconfig with
`KUBECONFIG_PATH` or `KUBECONFIG_BASE64`. It then acts as whatever identity
that file carries and ignores the ServiceAccount entirely, so the ClusterRole
above stops being the boundary. Prefer the in-cluster ServiceAccount unless the
control plane genuinely runs outside the cluster it manages.

If Cilium is your CNI, set `cilium.enabled: true` to add the
CiliumNetworkPolicy / CiliumEnvoyConfig grants that back per-tenant policy and
basic-auth-protected ingresses. Basic auth works without it too; see
[Protecting an ingress](#protecting-an-ingress) for how the enforcement point
is chosen.

> **Upgrading from a chart older than this change:** the ClusterRole was
> renamed from `<release>-image-builder-manager` to `<release>-server` and the
> ServiceAccount moved out from under `builders.enabled`.
>
> The new ClusterRole is a strict superset of the old one, and the
> ServiceAccount name is unchanged, so `helm upgrade` needs no special handling
> and there is no window where the server has fewer permissions than before.
> Helm won't garbage-collect the old objects though, so clean them up **after**
> the upgrade succeeds — not before, or you'll revoke permissions from the
> running pods:
>
> ```bash
> kubectl delete clusterrole,clusterrolebinding <release>-image-builder-manager --ignore-not-found
> ```
>
> If you previously worked around the missing permissions by binding
> `cluster-admin` to the ServiceAccount, drop that too, once you've confirmed
> the new role works:
>
> ```bash
> kubectl delete clusterrolebinding orchard-server-admin --ignore-not-found
> ```

## DNS

You need domains you control:

- **App domain** (`gateway.http.appDomain`, e.g. `apps.example.com`): wildcard
  DNS `*.apps.example.com` pointing at your Gateway's LoadBalancer IP, plus a
  wildcard certificate (DNS-01). This is the single source of truth: the chart
  derives the server's `APP_DOMAIN`, the frontend's `PUBLIC_APP_DOMAIN`, and
  `PLATFORM_WILDCARD_DOMAINS` (which generated app URLs like
  `main-forge-16294e.apps.example.com` are built from) from it. Override any of
  them individually via `server.env` / `frontend.env` /
  `tenant.wildcardDomains` if you need them to differ.
- **Ingress CNAME target** (`INGRESS_CNAME`): the hostname users point their
  custom domains at. Unset disables DNS validation for custom domains.
- **Platform domain**: where the Orchard UI itself lives (`ingress.host`).
- **DB domain** (`PUBLIC_DB_DOMAIN`, optional): wildcard for publicly exposed
  databases. Keep it in sync with `certificates.wildcards.db.domain`.
- **Public port domain** (`PUBLIC_DEPLOYMENT_DOMAIN`, optional): wildcard for
  publicly exposed deployment ports.
- **Vanity domain** (`BASE_DOMAIN`, optional): parent for org subdomains like
  `acme.example.com`.

These three are independent facts, not variations on the app domain. Each needs
its own DNS and wildcard certificate, and in practice they diverge: the Hack
Club cluster serves its UI from one domain, apps from a second, and org vanity
hosts from a third. So none of them is derived from another — guessing
`db.<appDomain>` would produce a hostname that doesn't resolve and a cert that
doesn't exist. Leave one unset and that feature turns off: public databases and
ports are addressed by `ip:port`, and org vanity subdomains are rejected with an
explanation rather than creating a broken ingress.

Note that a container `env` entry outranks every `envFrom` source in Kubernetes.
The chart therefore only injects `APP_DOMAIN` when you haven't set it yourself
in `server.env` and aren't using `server.envFrom` — otherwise it would silently
shadow a value you're supplying from a Secret.

The same applies to the app domain itself. With no `appDomain`, Orchard
generates no URLs and every deployment needs a custom domain — it never falls
back to a built-in default.

## Install

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard --create-namespace \
  -f my-values.yaml
```

The chart's [`AGENT.md`](../infra/charts/orchard/AGENT.md) is the full values
reference and troubleshooting guide. A minimal production values file
overrides at least:

```yaml
ingress:
  host: orchard.example.com
  tls:
    enabled: true
    # Either name a Secret you create yourself, or set issuerRef and the chart
    # issues the certificate for `host`. With neither, Traefik terminates using
    # its self-signed default cert and every browser rejects it.
    issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
gateway:
  http:
    appDomain: apps.example.com
tenant:
  storageClass: ""            # empty = cluster default
  ingressClass: nginx
  certClusterIssuer: letsencrypt-prod
signupMode: invite_only
datadog:
  enabled: false
builders:
  harbor:
    username: robot$orchard
    password: <registry password>
    hosts: [registry.example.com]
server:
  env:
    - { name: DOCKER_REGISTRY_PUSH, value: registry.example.com }
    - { name: DOCKER_REGISTRY_PULL, value: registry.example.com }
    - { name: REGISTRY_PROJECT, value: orchard }
    - { name: INGRESS_CNAME, value: ingress.example.com }
    - { name: FRONTEND_URL, value: https://orchard.example.com }
    - { name: JWT_SECRET, valueFrom: { secretKeyRef: { name: orchard-secrets, key: jwt } } }
    - { name: SECRETS_ENCRYPTION_KEY, valueFrom: { secretKeyRef: { name: orchard-secrets, key: enc } } }
```

Login options out of the box: email OTP (needs `SMTP_*` env) and passkeys.

## First sign-in

A fresh instance has no accounts and no superadmin, and it very likely has no
`SMTP_*` env either, so it cannot deliver an OTP. The way in is a **claim
link**: a single-use token that creates the first account, makes it the
superadmin, and signs it in, all in one step.

The link is printed three ways, whichever suits you:

- in the closing box the installer prints when it finishes
- in the server log on first boot (`kubectl -n orchard logs deploy/server`)
- on demand, by running `orchard-claim` on the host

```
$ orchard-claim

  Open this to claim the instance and sign in (valid for 24 hours):

    https://orchard.example.com/setup/claim?token=T2SdKq...

  It works once. Add a passkey straight after so you can sign back in.
```

Opening it asks for the email address the account should use and nothing else.
No confirmation email is sent, and the address is left unverified until email
actually works, because the token proved you own the host, not the mailbox.

The token is only ever stored hashed, so a lost one cannot be read back.
`orchard-claim` mints a replacement instead. It refuses once a superadmin
exists, and redeeming it is a single transaction, so it can't be replayed. The
only thing standing behind it is exec access on the server pod, which is
already equivalent to owning the instance.

### Add a passkey immediately

**With no SMTP and no identity provider, a passkey is your only way back in.**
The claim link is one-time, so once you close that tab a session cookie is all
you have. Go to Settings and register one before doing anything else.

Passkeys need no external service, and passkey sign-in needs no email address:
Orchard uses discoverable credentials, so the login page can identify you from
the authenticator alone. They also require a **secure context**, so the
instance must be serving a real certificate first — a browser refuses WebAuthn
behind a self-signed cert. `WEBAUTHN_RP_ID` defaults to the hostname in
`FRONTEND_URL`, so there is normally nothing to configure.

If you lose every passkey on an instance with no email transport, there is
currently no self-service recovery. Configure `SMTP_*` or an identity provider
before you are relying on a single authenticator.

### Changing settings later

`orchard-config` edits the values file the installer wrote and is the intended
way to change anything the install prompts didn't ask about:

```bash
orchard-config get signupMode
orchard-config set signupMode invite_only
orchard-config set ingress.tls.issuerRef.name letsencrypt
orchard-config set metrics.enabled false --apply
orchard-config list
orchard-config edit
```

Paths are dotted and are created if they don't exist, so setting
`ingress.tls.issuerRef.name` on a file that has no `issuerRef` block writes the
whole nesting. Values keep their YAML type: `false` and `2` land as a boolean
and an integer, a bare word stays a string.

Changes are written but **not deployed**. Pass `--apply` to run
`orchard-update` straight after, or leave it off while you make several edits
and run `orchard-update` once at the end.

The ones worth knowing:

| Path | What it does |
|---|---|
| `signupMode` | `open` / `invite_only` / `closed` |
| `ingress.tls.issuerRef.name` | ClusterIssuer for the Orchard UI's own certificate |
| `tenant.certClusterIssuer` | ClusterIssuer for user app certificates |
| `metrics.enabled` | the built-in VictoriaMetrics stack |
| `cilium.enabled` | Cilium-backed tenant policy and Envoy basic auth |
| `protection.orchardLogin` | offer "sign in with Orchard" on tenant hosts |
| `server.replicas` | control-plane API pods |

`orchard-update` on its own picks up new images and a new chart, but it reads
the values file as it finds it. It can't add settings that weren't there, which
is why an instance installed before a value existed needs `orchard-config set`
first.

### Configuring email later

Email is optional for a single-operator instance and required the moment you
want to invite anyone, since invites and OTPs are both delivered over it. Set
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` in
`server.env` and re-run the upgrade.

Until then, OTP requests still generate a code and write it to the server log
rather than sending it:

```
[EmailService] SMTP_HOST not set — email sending is disabled
[DEV] OTP code for you@example.com: 481920
```

That is a usable fallback for a lone operator reading their own logs, and a
reason to keep `signupMode: invite_only` — the chart default. The installer
sets it too. Switching to `open` on an instance that can send email turns the
login page into public registration.

## Footprint and scaling

Requests are sized for what the control plane consumes at rest, not for its
peak, since requests are what the scheduler actually reserves. At defaults with
one replica each, the control plane requests roughly 1 GiB of memory.

The bundled metrics stack (VictoriaMetrics, vmagent, kube-state-metrics,
node-exporter) is the single largest idle cost, and VictoriaMetrics sizes its
cache as a share of its memory *limit*, so it grows to fill whatever it is
given. On a small cluster:

```yaml
metrics:
  enabled: false
```

turns it off entirely — the deployment metrics graphs and usage pages go empty,
everything else is unaffected. To keep it but shrink it, lower
`metrics.victoriametrics.resources.limits.memory` and
`metrics.victoriametrics.memoryAllowedPercent`. The one-command installer
enables the stack only on hosts with 8 GB or more; `--metrics true|false`
overrides that.

The stateless tiers can scale on CPU instead of running a fixed replica count.
This needs metrics-server (k3s ships it):

```yaml
server:
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 8 }
frontend:
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 6 }
```

Scaling out is faster than scaling in (60s up, 5 min down), so a burst is
absorbed promptly without dropping capacity during a brief lull. When
autoscaling is on, the chart omits `replicas` from that Deployment so a
`helm upgrade` can't stomp on what the autoscaler settled at — which also means
`replicas` in your values is ignored for that tier.

`server.workers` moves builds and the apply queue onto their own pods and has
its own autoscaling block; it's the burstiest tier and benefits most.

## Single sign-on

SSO is configured in the UI, at two levels.

**Platform-wide** (Admin -> SSO): identity providers offered to everyone on
the login page. Pick a preset (Google, Microsoft Entra, GitHub, GitLab, Okta,
Auth0, Keycloak, Authentik, OneLogin, JumpCloud) or configure a generic
OpenID Connect or SAML 2.0 provider, paste the client credentials, and copy
the redirect URL it generates into the provider. Each connection carries its
own policy: whether it may create accounts, the role new members get, an
optional email-domain allowlist, and whether a verified email is required.

The same page has the per-organization kill switch. Turning SSO off for one
organization leaves its configuration intact but stops sign-ins, and the org
owner cannot re-enable it from their own settings.

**Per organization** (org settings -> SSO): an org configures its own
providers the same way, and gets a branded login page at
`https://<your-domain>/<org-slug>`, with no subdomain to set up. An org that
has verified an email domain also captures anyone typing a matching address on
the platform login page. "Require single sign-on" blocks email
codes, passkeys, and platform providers for that org's members.

Single sign-on is off for every organization until a platform administrator
allows it. An organization proves it owns an email domain by publishing a TXT record at
`_orchard-challenge.<domain>`. Verification is what allows an org's provider to
create accounts for people at that domain who have never signed in before, and
what routes those addresses to its login page. Only one organization can hold a
domain. Without it, an org's members join by invitation, where the emailed link
proves the recipient holds the mailbox.

Secrets (client secrets, signing certificates) are encrypted at rest with
`SSO_ENCRYPTION_KEY`; without it the server refuses to store them.

IdP URLs pointing at internal addresses (loopback, RFC1918, `.svc`,
`.cluster.local`, cloud metadata) are rejected at save time, since they drive
server-side fetches. If your IdP genuinely runs on internal DNS, set
`SSO_ALLOW_INTERNAL_IDP=true`.

A single env-configured provider is still supported and renders alongside the
database ones: `AUTH_PROVIDER=oidc` plus the `AUTH_OAUTH_*` env, or
`AUTH_PROVIDER=hackclub` for the Hack Club preset. `AUTH_PROVIDER=none`
disables it. SCIM provisioning is configured per organization in the UI.

## Node scheduling

Superadmins manage cluster nodes under Admin -> Nodes: cordon, set taints and
labels (Orchard patches the live node; a node informer mirrors state back into
the DB so reads never hit the kube-apiserver), and define **node pools**. A
pool maps a friendly name to a node label selector plus tolerations to inject,
so a workload assigned to it lands on (and tolerates) the intended nodes. Example:
taint a cheap background box `orchard.io/pool=background:NoSchedule`, label it
`orchard.io/pool=background`, create a "Background" pool that selects that label
and tolerates that taint, then assign your queue runner to it. Web workloads left
unassigned carry no toleration and never schedule there.

By default only superadmins assign pools. A superadmin can flip "Userspace
scheduling" under Admin -> Nodes to let normal users pick a pool that was marked
user-selectable. The `USERSPACE_NODE_SCHEDULING` env var overrides that toggle
when set (`true` forces it on, `false` forces it off and locks the switch);
leave it unset to control the feature from the UI. Pool placement applies to app
deployments, jobs, and CNPG databases.

## Protecting an ingress

Orchard can put an auth wall in front of a tenant host. Three modes, and only
one of them needs anything from the cluster:

| mode | what a visitor sees | requirements |
|---|---|---|
| `basic` | the browser's username/password dialog (HTTP Basic, RFC 7617) | none |
| `password` | an Orchard-hosted page asking for one shared password | none |
| `orchard` | "sign in with Orchard", and they must be a member of the project | `protection.orchardLogin: true` |

Set them with `PUT /apiv1/projects/:id/ingresses/:ingressId/protection`, body
`{ mode, username?, password?, bypassPaths? }`. `username` is only read for
`basic`. `bypassPaths` (up to 20) exempts webhook and healthcheck routes from
whichever wall is up.

Basic auth is also reachable as a `basicAuth` block when you create or update
an ingress, including from a template's `ingress:` config. That form is
equivalent to setting `mode: basic`, and it works on every cluster.

### How basic auth is enforced

There are two enforcement points and the cluster picks which one:

- **With Cilium**, Orchard writes a `CiliumEnvoyConfig` that puts an Envoy
  `basic_auth` filter in front of the backing Service. This is the stronger
  option: the password covers every path into that Service, including traffic
  that never passed your ingress controller.
- **Without Cilium**, the same credentials are checked by Orchard's protection
  proxy. The ingress backend is repointed at a headless Service that resolves
  to the control plane, which answers `401 WWW-Authenticate: Basic` until the
  right credentials arrive and proxies through once they do. No CNI features,
  no ingress-controller annotations, no CRDs.

The server decides by probing for the `cilium.io` API group and its own
permission to create `ciliumenvoyconfigs`, so nothing needs configuring either
way. `cilium.enabled: true` grants that permission and skips the probe;
`CILIUM_ENABLED=true|false` in `server.env` forces the answer.

The two differ in one way worth knowing: the proxy gates the HTTP route, so
anything already inside the cluster that can reach the pod directly is
unaffected. If that matters, pair it with a NetworkPolicy.

Passwords are stored bcrypt-hashed either way. The Envoy path additionally
derives the SHA-1 htpasswd string its filter needs, which is why the username
is stored alongside.

### "Sign in with Orchard"

`mode: orchard` redirects visitors to the control plane's login page and then
checks project membership, so it only makes sense when the people you are
gating already have Orchard accounts, and it needs `FRONTEND_URL` reachable
from wherever the app is served. The chart ships it off:

```yaml
protection:
  orchardLogin: true
```

The flag gates *choosing* the mode, not enforcing it. Turning it off does not
drop the wall on hosts that already use it, so an upgrade cannot silently
publish something that was private.

It also does not affect the generated URL a new deployment gets on the platform
wildcard domain. That one is member-gated from birth on purpose, and the people
it gates are project members, who have accounts on this instance by definition.
So you will still see `protectionMode: orchard` rows with the flag off.

### Gating at your ingress controller instead

Nothing stops you doing it yourself. Create the htpasswd Secret in the
deployment's namespace and set the annotations your controller expects, e.g.
for ingress-nginx:

```bash
htpasswd -nbB alice 's3cr3t' > auth
kubectl -n <tenant-namespace> create secret generic my-app-basic-auth --from-file=auth
```

```yaml
nginx.ingress.kubernetes.io/auth-type: basic
nginx.ingress.kubernetes.io/auth-secret: my-app-basic-auth
nginx.ingress.kubernetes.io/auth-realm: "Restricted"
```

HAProxy uses `haproxy.org/auth-secret`; Traefik wants a `basicAuth` Middleware
referenced from `traefik.ingress.kubernetes.io/router.middlewares`. Pass these
through the ingress's `annotations` field. Orchard only forwards annotation
keys on its allowlist (`ALLOWED_INGRESS_ANNOTATION_KEYS` in
`apps/server/src/kubernetes/kubernetes.service.ts`), and none of the ones above
are on it yet, so add the ones you need there first.


## What is not included

- Cluster bootstrap (nodes, CNI, operator installation): bring your own or
  see the quickstart for a local reference stack.
- DNS-01 issuer credentials and wildcard issuance: documented in
  `SETUP-wildcards.md`, secrets stay in your ops repo.
- Database backup schedules: CNPG `ScheduledBackup` resources are yours to
  define; the r2-proxy component brokers per-cluster credentials when
  enabled.
