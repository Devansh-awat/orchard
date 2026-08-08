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
For SSO against your own IdP, set `AUTH_PROVIDER=oidc` plus the
`AUTH_OAUTH_*` env (issuer discovery, PKCE-less code flow, claim mapping;
works with Keycloak, Authentik, Dex, Google, ...), and
`PUBLIC_OAUTH_PROVIDER=oidc` / `PUBLIC_OAUTH_PROVIDER_LABEL` on the frontend
for the login button. Hack Club OAuth is the `hackclub` preset. Enterprise
SSO/SCIM is additionally configurable per organization in the UI.

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
