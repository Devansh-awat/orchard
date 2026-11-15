---
title: Go to production
description: Choose between the single-node installer and a multi-node Helm cluster, replace bundled components with ones you operate, and prepare secrets, signups, backups, isolation, and version pinning for production.
sidebar:
  order: 5
---

The one-command installer gives you a working Orchard instance on one Linux machine. That machine holds everything: the cluster, the disks, the registry, and the backups. Because of this, the installer suits a home lab, a side project, a small team, or a trial of Orchard. For a production setup, Orchard recommends the Helm chart on a multi-node cluster that you build for it, with the bundled components replaced by ones you operate.

This page explains the difference, lists the components you can replace, and then walks through the settings to check before other people depend on your instance.

## Choose a layout

The installer builds a single-node [k3s](https://k3s.io/) cluster. k3s is a certified Kubernetes distribution and is used in production. The limitation is the installer's single-node layout, not k3s:

- **One machine is a single point of failure.** If the machine stops, every app, database, and the dashboard stop with it.
- **Volumes use `local-path`.** Each volume is a directory on that machine's disk, with no replication.
- **The registry is bound to loopback.** The bundled zot registry listens on `127.0.0.1` on the install host, and the node pulls tenant images through it. Another machine cannot pull from it, so an installer host cannot take more nodes. Refer to [Add and remove nodes](/operate/nodes/#on-an-installer-host).
- **Backups stay on the same disk.** Database backups go to [the store on the server](/data/backups/#the-store-on-the-server), which does not survive the loss of the machine unless you [add S3 storage](/operate/storage/).

| Layout                             | Suits                                                                  | You operate                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| One-command installer              | A home lab, a side project, a small team, or a trial                   | One Linux machine. The installer and `orchardctl` manage the rest.             |
| Helm chart on a multi-node cluster | Production, and any instance where people depend on uptime and backups | The cluster, its storage, its registry, and its object storage, as you choose. |

For production, run the Helm chart on a multi-node cluster built for it, such as one running [Talos Linux](https://docs.siderolabs.com/talos). Hack Club runs Orchard this way, on six Talos Linux nodes. Talos is an operating system made only to run Kubernetes, and it offers the gVisor and Kata runtimes that [kernel isolation](/operate/security/#kernel-isolation) needs as system extensions. For the chart install, refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).

When you build the cluster, plan for the following:

- **A CNI that enforces NetworkPolicy.** Orchard recommends Cilium, which Hack Club runs on its Talos nodes. Talos deploys Flannel unless you configure another CNI, and Flannel does not enforce NetworkPolicy. For the supported CNIs, refer to [Supported CNIs](/operate/compatibility/#supported-cnis), and for Cilium on Talos, refer to [Deploying Cilium CNI](https://docs.siderolabs.com/kubernetes-guides/cni/deploying-cilium).
- **Kubernetes 1.30 or later**, for the [admission guard](/operate/security/#admission-guard-for-tenant-namespaces). For the distributions, CNIs, ingress controllers, and storage that Orchard supports, refer to [Compatibility](/operate/compatibility/).
- **The components below**, either the ones the chart expects or your replacements.

The chart's defaults describe the cluster that the Orchard project runs itself, with Harbor as the registry and the HAProxy ingress controller in the `network` namespace. The chart's own quick install was run end to end on a single node, and Hack Club runs the chart on a six-node cluster. Before you plan a cluster, read which configurations were tested in the [chart README](https://github.com/hackclub/orchard/tree/main/infra/charts/orchard#1-quick-install).

## Replace bundled components

On a Helm cluster, you decide which components Orchard runs and which ones you bring. The sections below list each bundled component, the replacements that the chart and the server support, and the settings for each. Replace what you already operate, and keep the rest.

### Registry

The installer runs zot, bound to loopback on its host. On a cluster, use a registry that every node can pull from, such as [Harbor](https://goharbor.io/docs/) or any other OCI registry.

| Setting                                         | Where              | Value                                                                                   |
| ----------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `builders.harbor.username`, `password`, `hosts` | Chart values       | The account that builds push with, and the registry hosts it applies to.                |
| `builders.registryEgress`                       | Chart values       | The registry's namespace and port, so build pods can reach it.                          |
| `builders.httpRegistries`                       | Chart values       | Only for a registry that serves plain HTTP. Anything not listed uses HTTPS.             |
| `DOCKER_REGISTRY_PUSH`, `DOCKER_REGISTRY_PULL`  | `server.env`       | The address builds push to, and the address nodes pull from.                            |
| `REGISTRY_PROJECT`                              | `server.env`       | The project or path prefix that holds every tenant image. The default is `orchard`.     |
| `HARBOR_USERNAME`, `HARBOR_PASSWORD`            | `server.env`       | The same account. The server uses it to delete old images and to read scan results.     |
| Registry credentials                            | Every node runtime | Orchard does not add a pull secret to app pods, so each node needs its own credentials. |

Use a low-privilege robot account, not the Harbor `admin` account, because every tenant's builds share this login. When the registry is Harbor, Orchard detects it through the Harbor API and can use Harbor's own scanner. For the steps, refer to [Turn on image builds](/start/install/#turn-on-image-builds), [Use your own registry](/operate/finishing-setup/#use-your-own-registry), and [Set up Harbor](/operate/image-scanning/#set-up-harbor).

### Object storage

The installer runs an S3-compatible store inside the cluster (`objectStorage.local.enabled: true`). The chart leaves it off. Use external S3-compatible storage, such as Amazon S3 or Cloudflare R2, on infrastructure separate from the cluster.

- Leave `objectStorage.local.enabled` at `false`.
- Add the bucket at **Instance admin** > **Configuration** > **Object storage**. No chart change is needed.
- To manage storage from your values file instead, set `r2Proxy.upstream.*` with `r2Proxy.defaultBucket` or `r2Proxy.allowedBuckets`, and the `R2_*` variables in `server.env`.

For the settings for each provider, refer to [Add S3 storage](/operate/storage/#use-helm).

### Storage class

The installer uses `local-path`, which keeps each volume on one node's disk. On a cluster, use a replicated StorageClass, so that a volume survives the loss of a node.

- `tenant.storageClass` (`K8S_STORAGE_CLASS`) sets the class for tenant app volumes and databases. Empty uses the cluster default.
- Each platform volume has its own `storageClass` key, such as `postgres.storage.storageClass` and `redis.storageClass`. Empty uses the cluster default. The simplest option is to make your replicated class the cluster default.
- `admissionPolicies.storageClasses` limits which classes a tenant volume can name.

A StorageClass cannot change on an existing volume, so choose the class before you install. For the full list of volume keys, refer to the [chart README](https://github.com/hackclub/orchard/tree/main/infra/charts/orchard#2-storage-classes).

### Ingress controller

Tenant apps use standard Kubernetes Ingress objects, so they route through the controller you name in `tenant.ingressClass` (`K8S_INGRESS_CLASS`). Request, error, and latency charts and access-log statistics come only from two controllers: Traefik and the HAProxy Kubernetes Ingress Controller. With another controller, apps still route, but those charts stay empty.

| Setting                                                    | Value                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.ingressClass`                                      | Your ingress class. Empty falls back to `haproxy`.                                                                                                                                |
| `tenant.ingressNamespaces`                                 | The controller's namespace, then `orchard`. Refer to [Let the ingress controller reach apps](/operate/finishing-setup/#let-the-ingress-controller-reach-apps).                    |
| `metrics.ingress.traefik.*` or `metrics.ingress.haproxy.*` | The namespace and pod labels of your controller. Refer to [Point app metrics at your ingress controller](/operate/finishing-setup/#point-app-metrics-at-your-ingress-controller). |
| `INGRESS_METRICS`                                          | `traefik` or `haproxy`, to force one adapter. Empty detects it for each app.                                                                                                      |

The chart routes the dashboard and the MCP endpoint with Traefik `IngressRoute` objects. Without Traefik, set `ingress.enabled` and `mcp.ingress.enabled` to `false`, and route the dashboard hostname yourself: `/apiv1` to the `server` Service on port `3001`, and everything else to the `frontend` Service on port `3000`.

### Redis

The chart runs one Redis pod. To use a Redis that you operate instead, set `redis.enabled: false` and add `REDIS_URL` to `server.env`. If you set `redis.url` and leave `redis.enabled` on, the server uses your URL, but the chart still deploys its own Redis pod.

### Control-plane Postgres

The chart creates the control-plane database as a CloudNativePG `Cluster` with one instance. Install the CloudNativePG operator first, and set `tenant.cnpgOperatorNamespace` to its namespace.

| Setting                         | Value                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `postgres.instances`            | More than `1` adds replicas, and CloudNativePG fails over to one if the primary is lost.            |
| `postgres.storage.storageClass` | Your replicated class. Empty uses the cluster default.                                              |
| `postgres.pooler.enabled`       | `true` puts PgBouncer in front of the database, which caps connections from many server pods.       |
| `postgres.backup.*`             | Continuous backups to S3. Off by default. Refer to [step 5](#5-back-up-the-control-plane-database). |

### Metrics and logs

The metrics and log stores (VictoriaMetrics, vmagent, VictoriaLogs, and Vector) are part of the chart and cannot be replaced with your own monitoring stack. You can resize them, or turn them off with `metrics.enabled: false` and `logs.enabled: false`. Off, the dashboard has no charts or log history, and everything else keeps working. For sizes, refer to [Scale the control plane](/operate/scale-control-plane/).

To send server traces and profiles to Datadog, set `datadog.enabled: true`. This is in addition to the bundled stack, not a replacement for it.

## 1. Check your secrets

The installer generates secrets. An instance assembled by hand may still use example values.

| Variable                 | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `JWT_SECRET`             | Signs sessions. Anyone who knows this value can create a session. |
| `SECRETS_ENCRYPTION_KEY` | Encrypts stored secrets. Orchard cannot save secrets without it.  |

Store both in a Kubernetes Secret. Do not store them in a values file in a repository.

:::caution
Changing `SECRETS_ENCRYPTION_KEY` makes existing stored secrets unreadable. Set it once, before anyone stores secrets.
:::

## 2. Close signups

The default for the chart and the installer is `invite_only`. Claiming the instance works in every mode.

```yaml
signupMode: invite_only # or: closed
```

With `open` on a public URL, anyone who finds the URL can create an account and run workloads on your hardware.

## 3. Check your superadmins

A new instance has a single-use setup token that is valid for 24 hours. Redeem it with the account that should own the instance. For more information, refer to [Claim the instance](/start/install/#claim-the-instance).

After you claim the instance, go to **Instance admin** > **Users** and confirm that the list of superadmins is correct.

## 4. Check TLS settings

Set the following server variables:

```bash
SESSION_COOKIE_SECURE=true
TRUST_PROXY=1
```

- `SESSION_COOKIE_SECURE=true` stops browsers from sending session cookies over plain HTTP.
- `TRUST_PROXY` is the number of proxy hops to trust when Orchard finds the client IP address, or a comma-separated list of proxy CIDRs. The chart sets it to `1`, for a single ingress in front of the API. Unset, the server trusts no forwarded header. A value that is too high lets a client spoof its IP address with a header, which weakens per-IP rate limits. A private address is never trusted only because it is private.

Behind a Cloudflare Tunnel, also set `CLIENT_IP_HEADER=cf-connecting-ip` and set `CLIENT_IP_HEADER_FROM` to the pod CIDR. The installer does this in `tunnel` mode. For more information, refer to [Request headers](/deploy/networking/#request-headers).

## 5. Back up the control-plane database

:::danger[Control-plane backups are off by default]
Neither the chart nor the installer turns on continuous backups of the control-plane database (`postgres.backup.enabled: false`). Until you complete this step, losing the database volume loses every organization, project, app definition, and stored secret on the instance.
:::

The control-plane database holds every organization, project, app definition, environment variable, and audit record. Tenant [database backups](/data/backups/) do not include it.

A new installer host also writes a daily `pg_dump` of this database to the object store on the same machine. That dump undoes a mistake, but it shares a disk with the database, so it does not protect you if the machine is lost. For dumps to another location, refer to [Schedule database dumps](/operate/database-dumps/).

Continuous backups need S3-compatible storage on another machine.

:::caution
Archiving write-ahead logs (WAL) is not a backup. A restore replays WAL onto a base backup. Without a base backup, archived WAL restores nothing.
:::

1. Create a bucket, and a key that can read, write, and delete in it.
2. Add the key to the namespace that Orchard runs in. The chart reads the names `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY`.

   ```bash
   kubectl -n orchard create secret generic orchard-db-backup \
     --from-literal=ACCESS_KEY_ID=<KEY_ID> \
     --from-literal=ACCESS_SECRET_KEY=<SECRET>
   ```

3. Set the chart values. On an installer host, run the following commands:

   ```bash
   sudo orchardctl config set postgres.backup.destinationPath s3://my-bucket/orchard-db
   sudo orchardctl config set postgres.backup.endpointURL https://s3.example.com
   sudo orchardctl config set postgres.backup.enabled true --apply
   ```

   On a Helm install, add the following to your values file:

   ```yaml
   postgres:
     backup:
       enabled: true
       destinationPath: s3://my-bucket/orchard-db
       endpointURL: https://s3.example.com # leave out for AWS S3
       secretName: orchard-db-backup # the default
       retentionPolicy: 30d # the default
       schedule: '0 30 1 * * *' # the default, six fields, with seconds
   ```

4. Check that the first base backup finished and that WAL is arriving. The first backup starts when the `ScheduledBackup` exists.

   ```bash
   kubectl -n orchard get backups.postgresql.cnpg.io
   kubectl -n orchard get clusters.postgresql.cnpg.io orchard-db \
     -o jsonpath='{.status.firstRecoverabilityPoint}{"\n"}{.status.conditions[?(@.type=="ContinuousArchiving")].status}{"\n"}'
   ```

5. To test a restore, create a scratch namespace and copy the Secret into it.

6. Apply the following cluster, then check the data:

   ```yaml
   apiVersion: postgresql.cnpg.io/v1
   kind: Cluster
   metadata:
     name: orchard-db-restore
     namespace: orchard-restore-test
   spec:
     instances: 1
     storage:
       size: 10Gi
     bootstrap:
       recovery:
         source: orchard-db
     externalClusters:
       - name: orchard-db
         barmanObjectStore:
           serverName: orchard-db
           destinationPath: s3://my-bucket/orchard-db
           endpointURL: https://s3.example.com
           s3Credentials:
             accessKeyId:
               name: orchard-db-backup
               key: ACCESS_KEY_ID
             secretAccessKey:
               name: orchard-db-backup
               key: ACCESS_SECRET_KEY
   ```

If the barman cloud plugin is already installed in the cluster, you can set `postgres.backup.method` to `plugin`. The restore example applies to the default method.

A restore test proves that the backup is readable. Bringing a whole instance back on a new machine takes more steps, and Orchard has not tested that procedure end to end. For the steps, refer to [Back up and restore an instance](/operate/backup-and-restore/).

## 6. Configure object storage for tenant backups

Managed databases need a backup bucket. An installer host uses [the store on the server](/data/backups/#the-store-on-the-server) by default, which shares a disk with the databases.

To use S3 or R2, go to **Instance admin** > **Configuration** > **Object storage**. An organization can also set its own bucket at **Organization settings** > **Backups**. For more information, refer to [Add S3 storage](/operate/storage/).

## 7. Choose your isolation settings

If anyone other than you can deploy, read [Security and isolation](/operate/security/). Network isolation is on by default. Kernel isolation is off. To run untrusted code, install gVisor and Kata, and turn on `tenantSandbox` and `builderSandbox`.

## 8. Set quotas

Set organization caps and member allowances before people start to deploy. For more information, refer to [Set quotas](/teams/quotas/).

## 9. Set up email

Set `SMTP_*` so that sign-in codes, invitations, and notifications arrive. For more information, refer to [Set up email](/operate/finishing-setup/#set-up-email).

Without email, Orchard hides email codes and a new member can only sign in through an identity provider. For an existing account, an operator can run [`sudo orchardctl login --email <ADDRESS>`](/operate/host-commands/#login) to print a one-time link.

## 10. Use a wildcard certificate

By default, Orchard issues a certificate for each hostname over HTTP-01, so each new app waits for an ACME request. A wildcard certificate covers every generated hostname at once, and needs a DNS-01 issuer. For more information, refer to [Set up wildcard certificates](/operate/wildcard-certificates/).

## 11. Pin your version

An unpinned instance moves to the newest release on every update. On an installer host with [automatic updates](/operate/upgrades/#upgrade-an-installer-host), that happens every night. Pin a version, read the release notes, and upgrade when you decide to.

On a Helm install, pass `--version` on every upgrade:

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version <VERSION> -n orchard -f my-values.yaml --server-side=false
```

On Helm 3, leave out `--server-side=false`. A published chart sets the server, frontend, MCP, and backup proxy images to the versions in that release, so pinning the chart pins them too. Do not set `server.image.tag` or `frontend.image.tag` to `latest` in your values.

On an installer host, refer to [Pin a version on an installer host](/operate/upgrades/#pin-a-version-on-an-installer-host).

Release notes are on [GitHub Releases](https://github.com/hackclub/orchard/releases). Each service has its own release, tagged `<service>/v<version>`, for example `server/v2.95.4`. The chart has no release page of its own. Its version is the highest version among the services it ships, so the release with that number names the newest change.

## Verify the configuration

Run the following commands:

```bash
kubectl -n orchard exec deploy/server -- printenv SIGNUP_MODE
kubectl get runtimeclass
kubectl -n orchard get scheduledbackups.postgresql.cnpg.io
helm list -n orchard
```

- The first command prints `invite_only` or `closed`.
- If the second command prints nothing and other people can deploy, return to [Security and isolation](/operate/security/).
- The third command lists a `ScheduledBackup`. If it prints nothing, control-plane backups are off. Return to [step 5](#5-back-up-the-control-plane-database).
- The last command shows the chart version you run.

You now have an instance that you can hand to other people. To turn on the optional parts of the setup, refer to [Finish instance setup](/operate/finishing-setup/).

## Related resources

- [Upgrade Orchard](/operate/upgrades/) - Upgrade an installer host or a Helm install, and pin a version.
- [Back up and restore an instance](/operate/backup-and-restore/) - Learn what to back up and how to bring back the control plane.
- [Manage nodes and pools](/operate/nodes/) - Add nodes to a cluster and control where workloads run.
