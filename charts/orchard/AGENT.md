# Orchard Helm Chart — Agent Install Guide

Chart published to: `oci://ghcr.io/leafdtk/leaf/charts/orchard:0.1.0`

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
  oci://ghcr.io/leafdtk/leaf/charts/orchard \
  --version 0.1.0 \
  --namespace orchard \
  --create-namespace \
  -f my-values.yaml
```

Inspect what will be applied first:

```bash
helm template orchard oci://ghcr.io/leafdtk/leaf/charts/orchard --version 0.1.0 -f my-values.yaml | less
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
| `orchard-metrics`  | VictoriaMetrics StatefulSet, vmagent, kube-state-metrics, node-exporter DaemonSet |
| cluster-scoped     | `ClusterRole`/`ClusterRoleBinding` for builder management and metrics scraping |

The server deployment gets `DATABASE_URL` injected automatically from the
CNPG-managed secret `orchard-db-app` (key `uri`).

Routing (Traefik IngressRoute on `Host(ingress.host)`):

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

### Image defaults (`image.*`)

| Key | Default | Description |
|---|---|---|
| `image.registry` | `ghcr.io` | Container registry host. |
| `image.repository` | `hackclub/leaf` | Repository prefix. Final ref = `{registry}/{repository}/{component}:{tag}`. Override to `leafdtk/leaf` if pulling from your fork's GHCR. |
| `image.pullPolicy` | `IfNotPresent` | Applied to all app containers. |
| `image.pullSecrets` | `[]` | List of `imagePullSecrets` names. Required if images are private. |

### Frontend (`frontend.*`)

| Key | Default | Description |
|---|---|---|
| `frontend.enabled` | `true` | Deploy the SvelteKit frontend. |
| `frontend.replicas` | `1` | Replica count. |
| `frontend.image.name` | `frontend` | Image name suffix. |
| `frontend.image.tag` | `""` | Tag override; empty falls back to `Chart.AppVersion`. Use `sha-<commit>` to pin. |
| `frontend.service.port` | `3000` | ClusterIP Service port. |
| `frontend.resources` | requests `100m/256Mi`, limits `1/1Gi` | Standard k8s resource block. |
| `frontend.env` | `[]` | Extra env vars (k8s env list). |

### Server (`server.*`)

| Key | Default | Description |
|---|---|---|
| `server.enabled` | `true` | Deploy the NestJS server. |
| `server.replicas` | `1` | Replica count. |
| `server.image.name` | `server` | Image name suffix. |
| `server.image.tag` | `""` | Tag override; empty → `Chart.AppVersion`. |
| `server.service.port` | `3001` | ClusterIP Service port. |
| `server.resources` | requests `200m/512Mi`, limits `2/2Gi` | Resource block. |
| `server.env` | `[]` | Extra env vars. `DATABASE_URL` is injected automatically from `orchard-db-app` when `postgres.enabled=true`. |
| `server.envFrom` | `[]` | `envFrom` list (configMapRef / secretRef). |

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

### Ingress / Traefik (`ingress.*`)

| Key | Default | Description |
|---|---|---|
| `ingress.enabled` | `true` | Create the Traefik `IngressRoute`. |
| `ingress.host` | `orchard.local` | **The domain.** Used in the `Host(...)` match. Set this to your real FQDN. |
| `ingress.entryPoints` | `[websecure]` | Traefik entryPoints to bind. Use `[web]` for HTTP-only. |
| `ingress.tls.enabled` | `true` | Emit a `tls:` block on the IngressRoute. |
| `ingress.tls.secretName` | `""` | Name of an existing TLS secret. Empty uses Traefik's default cert. |
| `ingress.middlewares` | `[]` | List of `{name, namespace}` refs applied to both routes. |

Routing is fixed: `PathPrefix(/apiv1)` → server, everything else → frontend, both bound to `Host(ingress.host)`.

### Builders (`builders.*`)

| Key | Default | Description |
|---|---|---|
| `builders.enabled` | `true` | Install the `orchard-builders` namespace + RBAC + secrets. |
| `builders.namespace` | `orchard-builders` | Namespace where BuildKit pods will run. |
| `builders.harbor.username` | `admin` | Harbor registry username (written to `harbor-registry-creds` dockerconfigjson). |
| `builders.harbor.password` | `Harbor12345` | Harbor password. **Override this.** |
| `builders.harbor.hosts` | `[harbor-core.harbor.svc.cluster.local, harbor.1mp.dev]` | Hosts the credentials apply to. |
| `builders.r2.accessKeyId` | `""` | Cloudflare R2 access key for BuildKit S3-style cache. |
| `builders.r2.secretAccessKey` | `""` | Cloudflare R2 secret. |
| `builders.quota.requestsCpu` | `"16"` | Namespace ResourceQuota: total CPU requests. |
| `builders.quota.requestsMemory` | `"32Gi"` | Total memory requests. |
| `builders.quota.limitsCpu` | `"32"` | Total CPU limits. |
| `builders.quota.limitsMemory` | `"64Gi"` | Total memory limits. |
| `builders.quota.pods` | `"10"` | Max concurrent builder pods. |

The chart also creates a ClusterRoleBinding granting the `default` ServiceAccount in `.namespace` permission to manage Jobs/Pods/Secrets in `builders.namespace`.

### Metrics (`metrics.*`)

| Key | Default | Description |
|---|---|---|
| `metrics.enabled` | `true` | Install the orchard-metrics stack. |
| `metrics.namespace` | `orchard-metrics` | Namespace for the metrics stack. Referenced inside the vmagent scrape config and remote-write URL. |
| `metrics.victoriametrics.image` | `victoriametrics/victoria-metrics:v1.106.1` | VM image. |
| `metrics.victoriametrics.retention` | `30d` | `-retentionPeriod` flag. |
| `metrics.victoriametrics.storage.size` | `5Gi` | StatefulSet PVC size. |
| `metrics.victoriametrics.storage.storageClass` | `longhorn` | StorageClass for the VM data PVC. |

`vmagent`, `kube-state-metrics`, and `node-exporter` versions are pinned inside the chart templates (not exposed). Edit the chart if you need to bump them.

---

### Example: production override

```yaml
namespace: orchard

image:
  repository: leafdtk/leaf
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
ingress:   { enabled: false }
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

Images live under `ghcr.io/leafdtk/leaf/{frontend,server,mcp}` and are
public by default. If made private, create a pull secret and reference it:

```yaml
image:
  pullSecrets: [ghcr-pull]
```

---

## 7. Upgrades

```bash
helm upgrade orchard oci://ghcr.io/leafdtk/leaf/charts/orchard \
  --version <new-version> -n orchard -f my-values.yaml
```

CNPG handles rolling Postgres upgrades on its own. Bumping `postgres.instances`
adds replicas; the chart does not configure backup — configure CNPG
`ScheduledBackup` separately if needed.

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
