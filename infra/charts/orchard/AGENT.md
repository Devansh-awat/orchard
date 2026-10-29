# Orchard Helm Chart — Agent Install Guide

Chart published to: `oci://ghcr.io/hackclub/orchard/charts/orchard:0.1.0`

This chart installs the Orchard app stack into a Kubernetes cluster:
frontend + server + Traefik IngressRoute, a CloudNativePG `Cluster`,
the image-builder namespace/RBAC/secrets, and the orchard-metrics stack
(VictoriaMetrics + vmagent + kube-state-metrics + node-exporter).

It does **not** install operators or CRDs. The cluster must already have:

- **CloudNativePG operator** — provides `postgresql.cnpg.io/v1` `Cluster`
- **Traefik** with the `traefik.io/v1alpha1` CRDs and a `websecure` entryPoint
- A default StorageClass matching the values (defaults to `longhorn`)

---

## 1. Quick install

```bash
helm install orchard \
  oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version 0.1.0 \
  --namespace orchard \
  --create-namespace \
  -f my-values.yaml
```

Inspect what will be applied first:

```bash
helm template orchard oci://ghcr.io/hackclub/orchard/charts/orchard --version 0.1.0 -f my-values.yaml | less
```

---

## 2. Minimum `my-values.yaml`

```yaml
ingress:
  host: orchard.example.com
  tls:
    enabled: true
    secretName: orchard-tls          # cert-manager / pre-existing secret

builders:
  r2:
    accessKeyId: "REPLACE_ME"
    secretAccessKey: "REPLACE_ME"
  harbor:
    username: admin
    password: "REPLACE_ME"

# Pin image tags to a known-good commit (optional — defaults to AppVersion)
frontend:
  image: { tag: "sha-<commit>" }
server:
  image: { tag: "sha-<commit>" }
```

If the cluster's default StorageClass is not `longhorn`, also override:

```yaml
postgres:
  storage: { storageClass: <sc-name> }
metrics:
  victoriametrics:
    storage: { storageClass: <sc-name> }
```

---

## 3. What lands where

| Namespace          | Resources |
|--------------------|-----------|
| `orchard`          | `frontend` / `server` Deployments + Services, Traefik `IngressRoute`, CNPG `Cluster` (`orchard-db`) |
| `orchard-builders` | SA, RBAC, Harbor + R2 secrets, BuildKit ConfigMap, ResourceQuota, LimitRange, NetworkPolicy |
| `orchard-metrics`  | VictoriaMetrics StatefulSet, vmagent, kube-state-metrics, node-exporter DaemonSet, VictoriaLogs StatefulSet, Vector DaemonSet |
| cluster-scoped     | `ClusterRole`/`ClusterRoleBinding` for builder management and metrics scraping |

The server deployment gets `DATABASE_URL` injected automatically from the
CNPG-managed secret `orchard-db-app` (key `uri`).

Routing (Traefik IngressRoute on `Host(ingress.host, ...ingress.extraHosts)`):

- `PathPrefix(/apiv1)` → `server:3001`
- everything else      → `frontend:3000`

---

## 4. Full values reference

Every key the chart honors, with defaults from `values.yaml`.

### Top-level

| Key | Default | Description |
|---|---|---|
| `namespace` | `orchard` | Namespace the app components install into. |
| `createNamespace` | `true` | Render a `Namespace` object for `.namespace`. Set `false` if you manage the namespace yourself or pass `--create-namespace` to helm. |
| `cilium.enabled` | `false` | Add CiliumNetworkPolicy / CiliumEnvoyConfig grants to the server ClusterRole and set `CILIUM_ENABLED=true`. Only for clusters running Cilium as the CNI. Left off, the server probes for the `cilium.io` group plus create on `ciliumenvoyconfigs`: per-tenant policy falls back to plain NetworkPolicy, and basic auth on an ingress is enforced by the protection proxy instead of an Envoy filter. |
| `protection.orchardLogin` | `false` | Offer `protectionMode: orchard` ("sign in with Orchard") on tenant ingresses, via `PROTECTION_ORCHARD_LOGIN=true`. Gates selecting the mode, not enforcing it. `basic` and `password` are always available. |
| `tenant.wildcardDomains` | `""` | `.suffix=tlsSecret` pairs generated app URLs are built from. Empty derives one from `gateway.http.appDomain`. |
| `tenant.publicIp` | `""` | Fallback external IP publicly exposed ports and databases are published on, via `PUBLIC_EXPOSURE_IP`. An organization that sets its own overrides it. Empty means every organization must configure one before it can expose anything, and setting it here locks the admin-panel field. |

### Image defaults (`image.*`)

| Key | Default | Description |
|---|---|---|
| `image.registry` | `ghcr.io` | Container registry host. |
| `image.repository` | `hackclub/orchard` | Repository prefix. Final ref = `{registry}/{repository}/{component}:{tag}`. Matches where CI publishes images; override if pulling from your own registry. |
| `image.pullPolicy` | `IfNotPresent` | Applied to all app containers. |
| `image.pullSecrets` | `[]` | List of `imagePullSecrets` names. Required if images are private. |

### Frontend (`frontend.*`)

| Key | Default | Description |
|---|---|---|
| `frontend.enabled` | `true` | Deploy the SvelteKit frontend. |
| `frontend.replicas` | `2` | Replica count. Ignored when `frontend.autoscaling.enabled`. |
| `frontend.image.name` | `frontend` | Image name suffix. |
| `frontend.image.tag` | `""` | Tag override; empty falls back to `Chart.AppVersion`. Use `sha-<commit>` to pin. |
| `frontend.service.port` | `3000` | ClusterIP Service port. |
| `frontend.resources` | requests `50m/128Mi`, limits `1/512Mi` | Standard k8s resource block. |
| `frontend.autoscaling.enabled` | `false` | HPA on CPU. Needs metrics-server. When on, `replicas` is omitted from the Deployment so upgrades don't fight the HPA. |
| `frontend.autoscaling.minReplicas` / `maxReplicas` | `2` / `6` | Bounds. |
| `frontend.autoscaling.targetCPUUtilizationPercentage` | `75` | Scale-out target. |
| `frontend.env` | `[]` | Extra env vars (k8s env list). `PUBLIC_APP_DOMAIN` is injected from `gateway.http.appDomain`. |

### Server (`server.*`)

| Key | Default | Description |
|---|---|---|
| `server.enabled` | `true` | Deploy the NestJS server. |
| `server.replicas` | `2` | Replica count. Ignored when `server.autoscaling.enabled`. |
| `server.image.name` | `server` | Image name suffix. |
| `server.image.tag` | `""` | Tag override; empty → `Chart.AppVersion`. |
| `server.service.port` | `3001` | ClusterIP Service port. |
| `server.resources` | requests `100m/384Mi`, limits `2/2Gi` | Resource block. |
| `server.autoscaling.enabled` | `false` | HPA on CPU. Needs metrics-server. When on, `replicas` is omitted from the Deployment. |
| `server.autoscaling.minReplicas` / `maxReplicas` | `2` / `8` | Bounds. |
| `server.autoscaling.targetCPUUtilizationPercentage` | `70` | Scale-out target. |
| `server.workers.autoscaling.*` | `false`, `1`–`10`, `60%` | Same for the worker Deployment. Builds are the burstiest tier. |
| `server.env` | `[]` | Extra env vars. `DATABASE_URL` is injected automatically from `orchard-db-app` when `postgres.enabled=true`. `APP_DOMAIN` and `PLATFORM_WILDCARD_DOMAINS` are derived from `gateway.http.appDomain`; list them here to override. |
| `server.envFrom` | `[]` | `envFrom` list (configMapRef / secretRef). |

The chart sets `TENANT_SECRETS_CLUSTER_ROLE` to `<release>-tenant-secrets`, the ClusterRole the server binds into each tenant namespace. The server's own ClusterRole may `bind` only that name and holds no `escalate`.

### Postgres / CloudNativePG (`postgres.*`)

| Key | Default | Description |
|---|---|---|
| `postgres.enabled` | `true` | Create a CNPG `Cluster`. Requires the CNPG operator. |
| `postgres.name` | `orchard-db` | Cluster name. Also drives the auto-generated secret name (`{name}-app`). |
| `postgres.instances` | `1` | Number of Postgres replicas. |
| `postgres.imageName` | `""` | Override the CNPG Postgres image. Empty = operator default. |
| `postgres.database` | `orchard` | Initial database. |
| `postgres.owner` | `orchard` | Owner role for the initial database. |
| `postgres.storage.size` | `10Gi` | PVC size per instance. |
| `postgres.storage.storageClass` | `longhorn` | StorageClass for the data PVC. |
| `postgres.resources` | requests `200m/512Mi`, limits `2/2Gi` | Per-instance resources. |
| `postgres.pooler.image` | `ghcr.io/cloudnative-pg/pgbouncer:1.26.1` | PgBouncer image for the CNPG `Pooler`. Empty = operator default, which lags behind PgBouncer security releases. |

### Ingress / Traefik (`ingress.*`)

| Key | Default | Description |
|---|---|---|
| `ingress.enabled` | `true` | Create the Traefik `IngressRoute`. |
| `ingress.host` | `orchard.local` | **The domain.** Used in the `Host(...)` match, and the one links are generated with. Set this to your real FQDN. |
| `ingress.extraHosts` | `[]` | Additional names the same routes answer on, joined into the one `Host(...)` match. For a LAN box reachable by IP, machine name and Tailscale name. Matched only: they are not added to the certificate. |
| `ingress.entryPoints` | `[websecure]` | Traefik entryPoints to bind. Use `[web]` for HTTP-only. |
| `ingress.tls.enabled` | `true` | Emit a `tls:` block on the IngressRoute. |
| `ingress.tls.secretName` | `""` | Name of an existing TLS secret. Empty uses Traefik's default cert. |
| `ingress.tls.issuerRef` | `{}` | Name a ClusterIssuer and the chart issues the control-plane certificate itself, into `{release}-tls`. Without this or `secretName`, Traefik terminates with its self-signed default. |
| `ingress.middlewares` | `[]` | List of `{name, namespace}` refs applied to both routes. |

Routing is fixed: `PathPrefix(/apiv1)` → server, everything else → frontend, both bound to `Host(ingress.host, ...ingress.extraHosts)`.

### MCP (`mcp.*`)

The Model Context Protocol server, a second process out of the same image, on
its own hostname.

| Key | Default | Description |
|---|---|---|
| `mcp.enabled` | `true` | Deploy the MCP. Off, the Deployment and route go away **and** `MCP_ENABLED=false` is set on the server, which pins the runtime toggle in the admin panel off: nothing is serving MCP, so it cannot be switched back on from a browser. |
| `mcp.replicas` | `1` | Replica count. Ignored when `mcp.autoscaling.enabled`. |
| `mcp.image.name` | `mcp` | Image name suffix. Built from `apps/server/Dockerfile.mcp`. |
| `mcp.service.port` | `3100` | ClusterIP Service port. |
| `mcp.ingress.enabled` | `true` | Create the Traefik `IngressRoute`. |
| `mcp.ingress.host` | `""` | **The MCP domain**, e.g. `mcp.example.com`. Empty creates no route, and every URL derived from it stays unset. |
| `mcp.ingress.tls.issuerRef` | `{}` | As `ingress.tls.issuerRef`, into `{release}-mcp-tls`. An MCP client refuses a self-signed certificate outright, so this or `secretName` is not optional in practice. |
| `mcp.url` | `""` | The origin clients actually reach, when it differs from what the route implies. Behind a tunnel the route terminates plaintext in-cluster while the world connects over https, and an OAuth issuer that disagrees with the URL the client typed is rejected. Empty derives it from the route. |
| `mcp.env` | `[]` | Extra env vars. **`JWT_SECRET` and `MCP_SERVICE_TOKEN` have to be here and have to match the server's**: the MCP validates the sessions the server issued, and authenticates to the API as a service while passing the consenting user in headers. A mismatch starts cleanly and fails every tool call. |

Derived for you unless `mcp.env` already names them: `MCP_BASE_URL` (the OAuth
issuer and resource identifier), `FRONTEND_URL` (where a client is sent to
consent, taken from `server.env` when set), and `ORCHARD_API_URL` (the in-cluster
server Service). Left to their own defaults these point at localhost, which
fails only once a client tries to authorise.

**Setting `mcp.envFrom` disables all three.** A container `env` entry outranks
every `envFrom` source, so injecting one would silently shadow a value held in a
Secret rather than defer to it. The same rule applies to `MCP_BASE_URL` on the
server, which is set only so the DNS check in the admin panel knows the MCP's
hostname, and is skipped entirely when `server.envFrom` is present.

`mcp.ingress.host` also feeds the frontend's `PUBLIC_MCP_URL`, which is the URL
**Settings → MCP** shows people, and `SANDBOX_MCP_URL` when sandboxes are on. It
is the single place the MCP's address is configured.

### Builders (`builders.*`)

| Key | Default | Description |
|---|---|---|
| `builders.enabled` | `true` | Install the `orchard-builders` namespace + RBAC + secrets. |
| `builders.namespace` | `orchard-builders` | Namespace where BuildKit pods will run. |
| `builders.harbor.username` | `admin` | Harbor registry username (written to `harbor-registry-creds` dockerconfigjson). |
| `builders.harbor.password` | `Harbor12345` | Harbor password. **Override this.** |
| `builders.harbor.hosts` | `[harbor-core.harbor.svc.cluster.local, harbor.1mp.dev]` | Hosts the credentials apply to. |
| `builders.httpRegistries` | `[harbor-core.harbor.svc.cluster.local]` | Registries BuildKit talks plain HTTP to. Anything not listed is HTTPS. A self-host running zot lists `zot.orchard.svc.cluster.local:5000`. |
| `builders.r2.accessKeyId` | `""` | Cloudflare R2 access key for BuildKit S3-style cache. |
| `builders.r2.secretAccessKey` | `""` | Cloudflare R2 secret. |
| `builders.quota.requestsCpu` | `"16"` | Namespace ResourceQuota: total CPU requests. |
| `builders.quota.requestsMemory` | `"32Gi"` | Total memory requests. |
| `builders.quota.limitsCpu` | `"32"` | Total CPU limits. |
| `builders.quota.limitsMemory` | `"64Gi"` | Total memory limits. |
| `builders.quota.pods` | `"10"` | Max concurrent builder pods. |

The chart also creates a ClusterRoleBinding granting the `default` ServiceAccount in `.namespace` permission to manage Jobs/Pods/Secrets in `builders.namespace`.

### Backup proxy (`r2Proxy.*`)

| Key | Default | Description |
|---|---|---|
| `r2Proxy.enabled` | `true` | Deploy the proxy that brokers per-cluster backup credentials. |
| `r2Proxy.namespace` | `orchard-r2-proxy` | Its namespace. Tenant namespaces may reach it on 9000 and nothing else. |
| `r2Proxy.upstream.*` | | Endpoint, region and the real R2 key pair. Only the proxy ever holds these. |
| `r2Proxy.defaultBucket` | `""` | Bucket for organizations without their own. Also the default of the proxy's `ALLOWED_BUCKETS`. |
| `r2Proxy.databasePassword` | `""` | Password for the read-only `orchard_r2_proxy` postgres role. Empty keeps whatever the `orchard-r2-proxy-db` secret already holds, or mints one on first install. |
| `r2Proxy.databaseUrl` | `""` | Full override for a database the chart does not run. Give it a read-only role. |

When `postgres.enabled`, the CNPG cluster manages the `orchard_r2_proxy` login role and the server grants it `SELECT` on `databases`, `projects` and `organizations` at boot. The proxy never holds the app owner's credentials.

### Greenhouse (`sandbox.*`)

AI dev machines. Off by default. Full operator guide:
`apps/docs/src/content/docs/operate/greenhouse.md` (docs site: Operating Orchard → Running Greenhouse).

| Key | Default | Description |
|---|---|---|
| `sandbox.enabled` | `false` | Installs the plumbing below unless `install` is set. Greenhouse itself is the `greenhouse` graft: add it to `grafts:` to turn it on. |
| `sandbox.install` | `null` | Renders the machine namespace, ResourceQuota, LimitRange, NetworkPolicy, RBAC and the `SANDBOX_*` settings below. `null` follows `enabled`. Needed for the kubernetes runner of the `greenhouse` graft. |
| `sandbox.namespace` | `orchard-sandboxes` | Namespace for kubernetes machines. |
| `sandbox.image` | `debian:bookworm` | Base image. A bootstrap script installs sshd, git, tmux, Node.js, Claude Code, Codex and opencode on first boot. |
| `sandbox.runtimeClassName` | `kata` | RuntimeClass for machines. Empty runs them on runc, unprivileged, with a Filesystem home PVC. |
| `sandbox.idleTimeoutMinutes` | `60` | Stop machines with no terminal or SSH activity and no busy agent. `0` never. |
| `sandbox.maxLifetimeHours` | `168` | Stop machines this long after their last start. `0` never. |
| `sandbox.maxPerUserDefault` | `1` | Default machines per person; overridable per user in `/admin/users`. |
| `sandbox.storageClass` | `""` | Home volume StorageClass. Empty = cluster default. |
| `sandbox.diskSize` / `cpuLimit` / `memoryLimit` | `10Gi` / `"2"` / `4Gi` | Per-machine size. Keep memory at least `1Gi` under kata. |
| `sandbox.tunnelMode` | `""` | `portforward` only for a server outside the cluster. |
| `sandbox.homeMode` | `""` | `block`, `filesystem`, or empty for auto. |
| `sandbox.quota.{pods,cpu,memory}` | `"20"`, `"40"`, `"80Gi"` | Namespace ResourceQuota. |
| `sandbox.runners.default` | `""` | `kubernetes` or `vercel`. Empty lets the admin pick. |
| `sandbox.runners.kubernetes.enabled` | `null` | `true`/`false` pins the runner; `null` leaves it to the admin (default on). |
| `sandbox.runners.vercel.enabled` | `null` | Same for Vercel (default off). |
| `sandbox.runners.vercel.tokenSecret.{name,key}` | `""`, `token` | Secret holding the Vercel access token. |
| `sandbox.runners.vercel.{teamId,projectId,image,vcpus,timeoutMinutes}` | `""` | Vercel team, project and machine settings. |
| `sandbox.runners.bridgeBinaryUrl` | `""` | https URL of the linux/amd64 orchard CLI tarball used as the ssh bridge on Vercel machines. Empty = the pinned release, verified against its `checksums.txt`. |
| `sandbox.runners.bridgeBinarySha256` | `""` | SHA-256 of `bridgeBinaryUrl`. Required when that is set. |
| `sandbox.runners.previewDomain` | `""` | Bare domain for kubernetes previews. Must not share the Orchard cookie domain or hostnames. Also renders the preview IngressRoute and certificate below. |
| `sandbox.previews.route` | `true` | With a preview domain, renders a Traefik IngressRoute for `<port>-<id8>.<previewDomain>` on `ingress.entryPoints` to the `server` service. |
| `sandbox.previews.tls.secretName` | `""` | TLS Secret for previews. Empty = `<release>-sandbox-previews-tls`. |
| `sandbox.previews.tls.issuerRef` | `{}` | cert-manager issuer for the `*.<previewDomain>` Certificate (DNS-01 for wildcards). Empty = `certificates.issuer` when `certificates.enabled`, else no Certificate (bring the Secret). |

Prerequisites the chart does **not** install: the kubernetes-sigs/agent-sandbox controller and CRDs (`agents.x-k8s.io/v1beta1`), the kata RuntimeClass handler on the nodes, a VolumeSnapshotClass if you want forking, and for previews a wildcard DNS record (the route and certificate come from `sandbox.previews`). Values under `sandbox.runners` left empty render no env var, so those fields stay editable at Instance admin → Configuration → Sandbox runners. Slack and Linear integrations are configured there too (`SLACK_*`, `LINEAR_WEBHOOK_SECRET` via `server.env` if you want them pinned).

Example:

The `sandbox-isolation` NetworkPolicy is identical to the one the server applies on every leader election, ports included (`pnpm --filter server test:chart` compares them), so upgrades and the server never fight over it.

```yaml
sandbox:
  enabled: true
  runtimeClassName: kata
  runners:
    default: kubernetes
    vercel:
      enabled: true
      tokenSecret: { name: orchard-vercel, key: token }
      teamId: team_abc123
      projectId: prj_abc123
    previewDomain: orchard-preview.dev
```

### Metrics (`metrics.*`)

| Key | Default | Description |
|---|---|---|
| `metrics.enabled` | `true` | Install the orchard-metrics stack. |
| `metrics.namespace` | `orchard-metrics` | Namespace for the metrics stack. Referenced inside the vmagent scrape config and remote-write URL. |
| `metrics.victoriametrics.image` | `victoriametrics/victoria-metrics:v1.154.1` | VM image. Keep it on the same version as `metrics.vmagent.image`. |
| `metrics.victoriametrics.retention` | `30d` | `-retentionPeriod` flag. |
| `metrics.victoriametrics.storage.size` | `5Gi` | StatefulSet PVC size. |
| `metrics.victoriametrics.storage.storageClass` | `longhorn` | StorageClass for the VM data PVC. |
| `metrics.victoriametrics.memoryAllowedPercent` | `60` | `-memory.allowedPercent`. VM sizes its cache off the memory *limit*, so it grows to fill whatever it is given — lower this and the limit together to shrink idle RSS. |
| `metrics.victoriametrics.resources` | requests `100m/256Mi`, limits `1/1Gi` | Resource block. |
| `metrics.vmagent.image` | `victoriametrics/vmagent:v1.154.1` | vmagent image. |
| `metrics.vmagent.resources` | requests `50m/128Mi`, limits `500m/512Mi` | Resource block. |
| `metrics.kubeStateMetrics.image` | `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0` | kube-state-metrics image. Each release tracks one Kubernetes client-go minor (v2.20 is v1.36), so bump it with the cluster. |
| `metrics.kubeStateMetrics.resources` | requests `20m/64Mi`, limits `200m/256Mi` | Resource block. |
| `metrics.nodeExporter.image` | `prom/node-exporter:v1.12.1` | node-exporter image. |
| `metrics.nodeExporter.resources` | requests `20m/32Mi`, limits `200m/128Mi` | Resource block. |

This stack is the largest idle cost in the chart. `metrics.enabled: false` empties the deployment metrics graphs and usage pages and leaves everything else working.

The server gets `VICTORIAMETRICS_URL` built from `metrics.namespace` (port 8428) whenever the stack is on, so moving the namespace no longer leaves it pointing at `orchard-metrics`. Set it in `server.env` to point somewhere else; a value only in `server.envFrom` is shadowed by the chart's.

### Logs (`logs.*`)

VictoriaLogs plus a Vector DaemonSet, in `metrics.namespace` but toggled independently (the namespace is created here when `metrics.enabled` is false). Vector tails pods in namespaces labelled `orchard.my/managed=true` (and the legacy `orchard.dev/managed=true`) and the ingress controller's pods (`app.kubernetes.io/name in (kubernetes-ingress,traefik)`), and ships them to `/insert/jsonline` with `namespace,app,kind` as stream fields.

| Key | Default | Description |
|---|---|---|
| `logs.enabled` | `true` | Install VictoriaLogs + Vector and inject `VICTORIALOGS_URL` (`http://victorialogs.<metrics.namespace>.svc.cluster.local:9428`) into the server. |
| `logs.retention` | `14d` | `-retentionPeriod`. |
| `logs.maxDiskSpaceUsage` | `16GiB` | `-retention.maxDiskSpaceUsageBytes`. Oldest days are dropped past this whatever the retention says. Keep it below the PVC size. |
| `logs.victorialogs.image` | `victoriametrics/victoria-logs:v1.53.0` | VictoriaLogs image. |
| `logs.victorialogs.storage.size` / `storageClass` | `20Gi` / `longhorn` | StatefulSet PVC. |
| `logs.victorialogs.resources` | requests `100m/256Mi`, limits `1/1Gi` | Resource block. |
| `logs.vector.image` | `timberio/vector:0.60.0-distroless-libc` | Vector image. |
| `logs.vector.dataDir` | `/var/lib/vector-orchard` | Host directory for file checkpoints, so a restarted pod resumes instead of re-shipping. |
| `logs.vector.bufferEvents` | `20000` | In-memory sink buffer. When VictoriaLogs is down this fills and the newest events are dropped rather than back-pressuring the tail. |
| `logs.vector.resources` | requests `50m/128Mi`, limits `500m/512Mi` | Resource block. |

Each record carries `namespace`, `app` (pod label `orchard.my/app`, then `app.kubernetes.io/name`, then `app`), `kind` and `level` (`error`/`warn`/`info`/`debug`, read from JSON `level`/`severity` including pino numbers, then `level=` logfmt, then keywords). App logs (`kind=app`) also carry `pod`, `container`, `node`, `stream` and `slot` (`orchard.my/slot`, blue/green). Access logs (`kind=access`) carry `host`, `method`, `path` (query stripped), `route` (ids collapsed to `:id`, same rules as `normalizeRoute` in `apps/server/src/logs/logsql.ts`), `status`, `duration_ms`, `bytes`, `client_ip`, `user_agent`, `backend`, `service`, `server` and `ingress_pod`.

Access logs need the controller to log JSON:

- **HAProxy** (haproxytech kubernetes-ingress): set `controller.config.log-format` to a `%{+json}o` format with the field names above (`ts_ms`, `host`, `method`, `path`, `status`, `duration_ms`, `bytes`, `client_ip`, `user_agent`, `backend`, `server`) and capture host and UA into `txn.host`/`txn.ua` from `frontend-config-snippet`. The backend `<ns>_svc_<service>_<port>` gives namespace and service. Lines are capped at the log target's length (1024 bytes by default), so a very long path or UA truncates the JSON and that request is dropped.
- **Traefik**: `logs.access.enabled=true`, `logs.access.format=json` and `logs.access.fields.headers.names.User-Agent=keep` (the installer sets these). `ServiceName` (`<ns>-<service>-<port>@kubernetes`) does not mark where the namespace ends, so Vector matches its prefixes against tenant namespaces it has seen logs from in the last 7 days; access lines for an app whose namespace has logged nothing in that window are dropped.

### Gateway (`gateway.*`)

Renders the shared Gateway API `Gateway` objects and `ReferenceGrant`s that used to live in `k8s/gateway-api/`.

| Key | Default | Description |
|---|---|---|
| `gateway.enabled` | `true` | Master switch. Disable if you wire routing without Gateway API. |
| `gateway.namespace` | `network` | Namespace the Gateways + ReferenceGrants live in. Cert Secrets must be readable from here. |
| `gateway.gatewayClassName` | `traefik` | `GatewayClass` both Gateways attach to. |
| `gateway.http.enabled` | `true` | Render the L7 HTTP/HTTPS Gateway. |
| `gateway.http.name` | `http-gateway` | Gateway object name. The server (`ensureCustomDomainListener`) targets this exact name — keep in sync. |
| `gateway.http.appDomain` | `a.lfdl.ink` | Hostname pattern for autogen user app domains. Must match server `APP_DOMAIN` and frontend `PUBLIC_APP_DOMAIN`. |
| `gateway.http.appWildcardSecretName` | `""` | Secret holding the wildcard TLS cert for `*.{appDomain}`. Empty derives `wildcard-<appDomain with dots as dashes>-tls`, which the chart-managed `Certificate`, the Gateway listener and `PLATFORM_WILDCARD_DOMAINS` all agree on. |
| `gateway.db.enabled` | `true` | Render the L4 TCP Gateway for managed DBs. |
| `gateway.db.name` | `db-gateway` | Gateway object name. Targeted by the server's `ensureDbGatewayListener`. |
| `gateway.referenceGrants.enabled` | `false` | Render `ReferenceGrant`s. Only needed if Routes reference cross-namespace *backend Services* — not required for parentRefs (covered by `allowedRoutes.namespaces.from: All`). |
| `gateway.referenceGrants.fromNamespaces` | `[]` | Explicit list of source namespaces. One ReferenceGrant rendered per (namespace × Gateway). Empty = no grants rendered. Gateway API admission rejects empty / wildcard `from.namespace`, so this must be a concrete list. |

### Certificates (`certificates.*`)

Renders `cert-manager.io/v1 Certificate` resources for the configured wildcards.

| Key | Default | Description |
|---|---|---|
| `certificates.enabled` | `true` | Render `Certificate` resources. Set `false` if you pre-provision the TLS Secrets out-of-band. |
| `certificates.namespace` | `network` | Where Certificates + their Secrets live. Same as `gateway.namespace` in the default layout. |
| `certificates.issuer.name` | `letsencrypt-dns01-wildcard` | Name of the `ClusterIssuer` (or `Issuer`). **Must support DNS-01** — install acme-dns (see `kubeops/kubernetes/apps/network/acme-dns/SETUP.md`) before enabling. |
| `certificates.issuer.kind` | `ClusterIssuer` | `ClusterIssuer` or `Issuer`. |
| `certificates.duration` | `2160h` | Cert lifetime. |
| `certificates.renewBefore` | `360h` | Renewal lead time. |
| `certificates.privateKey` | `{algorithm: ECDSA, size: 256, rotationPolicy: Always}` | Passed verbatim to `spec.privateKey`. |
| `certificates.wildcards.app.enabled` | `true` | Issue the wildcard for autogen app domains. |
| `certificates.wildcards.app.domain` | `""` (→ `gateway.http.appDomain`) | Hostname pattern. Cert covers `*.{domain}` + `{domain}`. |
| `certificates.wildcards.app.secretName` | `""` (→ `gateway.http.appWildcardSecretName`) | Secret name. Consumed by the Gateway listener. |
| `certificates.wildcards.db.enabled` | `true` | Issue the wildcard for public CNPG TLS. |
| `certificates.wildcards.db.domain` | `db.orchard.my` | Hostname pattern. Matches server `PUBLIC_DB_DOMAIN`. |
| `certificates.wildcards.db.secretName` | `wildcard-db-orchard-my-tls` | Secret consumed by the server's `syncPublicTlsSecret` reflection. |

### Public TLS reflection (`publicTls.*`)

Exposes the secret-name knobs that the server reads at runtime (`PUBLIC_DB_TLS_*` env vars).

| Key | Default | Description |
|---|---|---|
| `publicTls.db.sourceNamespace` | `""` (→ `certificates.namespace`) | Where the server reads the wildcard DB cert FROM. Maps to `PUBLIC_DB_TLS_SOURCE_NAMESPACE`. |
| `publicTls.db.sourceSecret` | `""` (→ `certificates.wildcards.db.secretName`) | Source Secret name. Maps to `PUBLIC_DB_TLS_SOURCE_SECRET`. |
| `publicTls.db.localSecret` | `wildcard-db-tls` | Secret name written into each project namespace for CNPG to mount. Maps to `PUBLIC_DB_TLS_LOCAL_SECRET`. |

---

### Example: production override

```yaml
namespace: orchard

image:
  repository: hackclub/orchard
  pullSecrets: [ghcr-pull]

frontend:
  replicas: 2
  image: { tag: "sha-abc1234" }

server:
  replicas: 2
  image: { tag: "sha-abc1234" }
  env:
    - { name: LOG_LEVEL, value: info }

postgres:
  instances: 2
  storage: { size: 50Gi, storageClass: ceph-rbd }

ingress:
  host: orchard.example.com
  entryPoints: [websecure]
  tls:
    enabled: true
    secretName: orchard-tls
  middlewares:
    - { name: redirect-https, namespace: traefik }

builders:
  harbor:
    username: orchard-ci
    password: "${HARBOR_PASSWORD}"
    hosts: [harbor.example.com]
  r2:
    accessKeyId: "${R2_KEY}"
    secretAccessKey: "${R2_SECRET}"
  quota:
    requestsCpu: "32"
    requestsMemory: "64Gi"
    pods: "20"

metrics:
  victoriametrics:
    retention: 90d
    storage: { size: 50Gi, storageClass: ceph-rbd }
```

---

## 5. Toggles

Disable any component you don't want:

```yaml
postgres:  { enabled: false }   # if you bring your own DB; then set server.env.DATABASE_URL
builders:  { enabled: false }
metrics:   { enabled: false }
logs:      { enabled: false }
ingress:   { enabled: false }
mcp:       { enabled: false }   # also pins the admin panel's MCP toggle off
```

If `postgres.enabled: false`, supply `DATABASE_URL` via `server.env` or
`server.envFrom`:

```yaml
server:
  env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef: { name: my-db, key: uri }
```

---

## 6. Image pulls

Images live under `ghcr.io/hackclub/orchard/{frontend,server,mcp}` and are
public by default. If made private, create a pull secret and reference it:

```yaml
image:
  pullSecrets: [ghcr-pull]
```

---

## 7. Upgrades

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version <new-version> -n orchard -f my-values.yaml
```

CNPG handles rolling Postgres upgrades on its own. Bumping `postgres.instances`
adds replicas; the chart does not configure backup — configure CNPG
`ScheduledBackup` separately if needed.

Upgrading across the 2026-09 security release:

- the server's ClusterRole loses `escalate`; a new `<release>-tenant-secrets`
  ClusterRole appears and tenant namespaces created from now on bind to it.
  Existing namespaces keep their per-namespace Role, which stays valid.
- the backup proxy switches to the `orchard_r2_proxy` role. Backup lookups can
  fail for a few seconds after the rollout until the server's boot-time grant
  lands, then recover.
- `builders.httpRegistries` replaces the registries that were hardcoded in the
  BuildKit config. If you pushed to a plaintext registry other than the
  internal Harbor, list it.
- identity-provider-initiated SAML sign-in stops working, and org owners only
  sign in through providers they created; see the self-hosting guide.

---

## 8. Troubleshooting checklist

- `kubectl -n orchard get cluster orchard-db` → confirm CNPG `Cluster.status.phase` is `Cluster in healthy state`. If `not yet defined`, the CNPG operator isn't installed or isn't watching this namespace.
- `kubectl -n orchard get ingressroute` → if empty, Traefik CRDs aren't installed. Switch to a regular `Ingress` by setting `ingress.enabled: false` and creating one manually, or install Traefik.
- `kubectl -n orchard describe pod -l app.kubernetes.io/name=server` → look for `ImagePullBackOff` (pull secret) or `CreateContainerConfigError` (missing `orchard-db-app` secret — CNPG hasn't finished bootstrapping yet, retry).
- `kubectl -n orchard-metrics logs deploy/vmagent` → scrape errors mean the RBAC ClusterRoleBinding didn't apply (cluster-admin needed for install).

---

## 9. Uninstall

```bash
helm uninstall orchard -n orchard
kubectl delete ns orchard orchard-builders orchard-metrics
```

PVCs (CNPG data, VictoriaMetrics data) are **not** deleted automatically —
remove them manually if you want a clean slate:

```bash
kubectl -n orchard delete pvc -l cnpg.io/cluster=orchard-db
kubectl -n orchard-metrics delete pvc -l app=victoriametrics
```
