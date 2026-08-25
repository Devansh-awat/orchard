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

The chart creates the `orchard-server` ServiceAccount plus the ClusterRole its
mirror informers need (cluster-wide read/watch on pods, deployments, jobs,
cronjobs, services, ingresses, PVCs and CNPG clusters) and a namespaced Role
for the leader-election Leases. Per-tenant write access is bootstrapped by the
server itself when it creates a namespace.

## DNS

You need domains you control:

- **App domain** (`APP_DOMAIN`, e.g. `apps.example.com`): wildcard DNS
  `*.apps.example.com` pointing at your Gateway's LoadBalancer IP, plus a
  wildcard certificate (DNS-01).
- **Ingress CNAME target** (`INGRESS_CNAME`): the hostname users point their
  custom domains at.
- **Platform domain**: where the Orchard UI itself lives (`ingress.host`).
- **DB domain** (`PUBLIC_DB_DOMAIN`, optional): wildcard for publicly exposed
  databases, TLS via `certificates.wildcards.db`.

## Install

```bash
helm install orchard oci://ghcr.io/leafdtk/leaf/charts/orchard \
  --namespace orchard --create-namespace \
  -f my-values.yaml
```

The chart's [`AGENT.md`](../infra/charts/orchard/AGENT.md) is the full values
reference and troubleshooting guide. A minimal production values file
overrides at least:

```yaml
ingress:
  host: orchard.example.com
gateway:
  http:
    appDomain: apps.example.com
tenant:
  storageClass: ""            # empty = cluster default
  ingressClass: nginx
  certClusterIssuer: letsencrypt-prod
signupMode: open
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
    - { name: APP_DOMAIN, value: apps.example.com }
    - { name: INGRESS_CNAME, value: ingress.example.com }
    - { name: FRONTEND_URL, value: https://orchard.example.com }
    - { name: JWT_SECRET, valueFrom: { secretKeyRef: { name: orchard-secrets, key: jwt } } }
    - { name: SECRETS_ENCRYPTION_KEY, valueFrom: { secretKeyRef: { name: orchard-secrets, key: enc } } }
```

Login options out of the box: email OTP (needs `SMTP_*` env) and passkeys.

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

## What is not included

- Cluster bootstrap (nodes, CNI, operator installation): bring your own or
  see the quickstart for a local reference stack.
- DNS-01 issuer credentials and wildcard issuance: documented in
  `SETUP-wildcards.md`, secrets stay in your ops repo.
- Database backup schedules: CNPG `ScheduledBackup` resources are yours to
  define; the r2-proxy component brokers per-cluster credentials when
  enabled.
