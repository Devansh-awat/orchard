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
Hack Club OAuth activates when `HACKCLUB_CLIENT_*` env is set; enterprise
SSO/SCIM is configurable per organization in the UI.

## What is not included

- Cluster bootstrap (nodes, CNI, operator installation): bring your own or
  see the quickstart for a local reference stack.
- DNS-01 issuer credentials and wildcard issuance: documented in
  `SETUP-wildcards.md`, secrets stay in your ops repo.
- Database backup schedules: CNPG `ScheduledBackup` resources are yours to
  define; the r2-proxy component brokers per-cluster credentials when
  enabled.
