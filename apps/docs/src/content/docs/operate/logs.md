---
title: Logs and request data
description: The log store behind log search, the Requests view and attack signals, and the access logs it needs from the ingress controller.
sidebar:
  order: 8
---

Orchard keeps a copy of every app's logs, and of the ingress controller's access
log, in a log store inside the cluster. Live logs do not need it: they stream
straight from the pods. Everything that looks back in time does.

| Feature                                        | Where it shows                        | Needs                       |
| ---------------------------------------------- | ------------------------------------- | --------------------------- |
| Search over past logs, levels, context, export | **Observe → Logs**                    | the log store               |
| Requests view: per-route traffic, error rates  | **Observe → Requests**                | the log store + access logs |
| Latency percentiles (p50, p95, p99) per route  | **Observe → Requests**                | the log store + access logs |
| Attack attempts and top sources                | **Security** tab                      | the log store + access logs |
| Error grouping across replicas that are gone   | **Observe → Errors**, deploy verdicts | the log store               |

Without the store, error grouping falls back to the logs of the pods running
now, so a deploy verdict can miss errors from replicas that were already
replaced.

## What runs

Two pieces, both in the `orchard-metrics` namespace (`metrics.namespace`):

- **VictoriaLogs**, one StatefulSet named `victorialogs` with one volume.
- **Vector**, a DaemonSet. It tails pods in namespaces labelled
  `orchard.my/managed=true`, and the ingress controller's pods (label
  `app.kubernetes.io/name` set to `traefik` or `kubernetes-ingress`), and ships
  them to VictoriaLogs.

The chart sets `VICTORIALOGS_URL` on the server whenever `logs.enabled` is on.
It is on by default in the chart, from the one-command installer, and on an
installer host after `orchardctl update`. It is toggled separately from
`metrics.enabled`.

## Retention and disk

Two limits apply, and whichever is hit first wins:

- `logs.retention`: how long logs are kept. `14d` by default. The installer
  writes `7d` on a box with under 8G of RAM.
- `logs.maxDiskSpaceUsage`: the disk cap. Past it, the oldest days are dropped
  whatever the retention says. Keep it below the volume size.

The installer sizes the volume at a tenth of free disk, between 5G and 20G, and
sets the cap to 80% of that. The chart defaults are a 20Gi volume and a 16GiB
cap.

## Storage class

`logs.victorialogs.storage.storageClass` is empty by default, which means the
cluster's default StorageClass. The installer writes `local-path`, the class
k3s ships.

A StatefulSet cannot change its StorageClass in place. Two things keep upgrades
from tripping over that:

- When the value is empty, the chart reads the class off the live
  `victorialogs` StatefulSet and keeps it.
- On an installer host, `orchardctl update` checks the volume. If it is bound,
  the values file is pinned to the class it already has. If it never bound
  (the PVC is stuck `Pending`, usually because the class does not exist on this
  cluster), the StatefulSet and its empty claim are deleted and recreated on the
  configured class. The same check runs for VictoriaMetrics.

To move a store that already holds data to another class, set the value
explicitly. You start with an empty volume.

## Sizing

| Setting                       | Chart default                             | Installer, under 8G RAM                  |
| ----------------------------- | ----------------------------------------- | ---------------------------------------- |
| `logs.victorialogs.resources` | requests `100m/256Mi`, limits `1/1Gi`     | requests `50m/96Mi`, limits `1/384Mi`    |
| `logs.vector.resources`       | requests `50m/128Mi`, limits `500m/512Mi` | requests `20m/64Mi`, limits `500m/256Mi` |
| `logs.vector.bufferEvents`    | `20000`                                   | `5000`                                   |
| `logs.retention`              | `14d`                                     | `7d`                                     |

On a small box, trim these rather than turning the store off.

## Chart keys

| Key                                      | Default                                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| `logs.enabled`                           | `true`                                                          |
| `logs.retention`                         | `14d`                                                           |
| `logs.maxDiskSpaceUsage`                 | `16GiB`                                                         |
| `logs.victorialogs.image`                | `victoriametrics/victoria-logs:v1.53.0`                         |
| `logs.victorialogs.storage.size`         | `20Gi`                                                          |
| `logs.victorialogs.storage.storageClass` | `""`, the cluster default                                       |
| `logs.victorialogs.resources`            | see Sizing                                                      |
| `logs.vector.image`                      | `timberio/vector:0.60.0-distroless-libc`                        |
| `logs.vector.dataDir`                    | `/var/lib/vector-orchard`, a host path for Vector's checkpoints |
| `logs.vector.bufferEvents`               | `20000`                                                         |
| `logs.vector.resources`                  | see Sizing                                                      |

On an installer host:

```bash
sudo orchardctl config set logs.retention 30d
sudo orchardctl config set logs.maxDiskSpaceUsage 12GiB --apply
```

## Turning it off

```bash
sudo orchardctl config set logs.enabled false --apply
```

On a chart install, set `logs.enabled: false`. Live logs keep working. Log
search, the Requests view and the attack card go away. `orchardctl update`
does not turn it back on.

## Access logs

The Requests view and the attack card read the ingress controller's access log,
one JSON line per request. Vector parses two controllers: Traefik and HAProxy
(the haproxytech `kubernetes-ingress` chart). Lines from anything else are
ignored.

Query strings are stripped before a line is stored, and IDs in paths (numbers,
UUIDs, long hex or random-looking segments) are folded into `:id`, so
`/users/42` and `/users/43` count as one route.

### Traefik

Traefik needs three settings: access logging on, JSON format, and the
`User-Agent` header kept. Its JSON lines carry `ServiceName` by default; do not
drop that field, because it is how a line is matched to an app.

**On an installer host this is automatic.** The installer sets them, and
`orchardctl update` turns them on for a host installed before that. It upgrades
the `traefik` release with `--reuse-values`, on the chart version already
deployed, so Traefik itself does not move.

**On your own cluster**, the keys depend on the Traefik chart version. Check
which one you run:

```bash
helm list -n traefik
```

Chart 41 and later:

```bash
helm upgrade traefik traefik/traefik -n traefik \
  --version <deployed chart version> --reuse-values \
  --set accessLog.enabled=true \
  --set accessLog.format=json \
  --set accessLog.fields.headers.names.User-Agent=keep
```

Before chart 41:

```bash
helm upgrade traefik traefik/traefik -n traefik \
  --version <deployed chart version> --reuse-values \
  --set logs.access.enabled=true \
  --set logs.access.format=json \
  --set logs.access.fields.headers.names.User-Agent=keep
```

`ServiceName` looks like `<namespace>-<service>-<port>@kubernetes`. Orchard
stores it with each line and matches it against `<namespace>-<app>-<port>`, and
`<namespace>-<app>--green-<port>` for the green half of a blue-green deploy.
Lines for Traefik's own `@internal` services are dropped.

### HAProxy

HAProxy has no built-in JSON access log, so you give it a format with the field
names Vector reads: `ts_ms`, `host`, `method`, `path`, `status`, `duration_ms`,
`bytes`, `client_ip`, `user_agent`, `backend` and `server`. In the
`kubernetes-ingress` chart values:

```yaml
controller:
  config:
    syslog-server: 'address:stdout, format: raw, facility:daemon'
    log-format: '%{+json}o %(ts_ms)[request_date(ms)] %(host)[var(txn.host)] %(method)HM %(path)HPO %(status)ST %(duration_ms)Ta %(bytes)B %(client_ip)ci %(user_agent)[var(txn.ua)] %(backend)b %(server)s'
    frontend-config-snippet: |
      http-request set-var(txn.host) req.hdr(host)
      http-request set-var(txn.ua) req.fhdr(user-agent)
```

- The snippet captures the host and user agent while the request is parsed,
  since the log format cannot read request headers directly. `req.fhdr` keeps
  commas inside the user agent.
- Keep the explicit `syslog-server`. Without it the controller rebuilds its
  default log target on every sync, sees a change that is not one, and reloads
  HAProxy about once a minute. Each reload refuses long-lived HTTP/2 streams,
  which browsers report as `ERR_HTTP2_SERVER_REFUSED_STREAM`.
- The backend name, `<namespace>_svc_<service>_<port>`, tells Orchard which app
  a line belongs to.
- The stdout target cuts lines at 1024 bytes. A request with a very long path
  or user agent produces broken JSON and is dropped.

### Checking it works

Look at the controller's own output first. Each line should be a JSON object:

```bash
kubectl -n traefik logs deploy/traefik --tail=3
```

Then ask the store whether it has access lines:

```bash
kubectl -n orchard-metrics port-forward svc/victorialogs 9428:9428 &
curl -s http://127.0.0.1:9428/select/logsql/query \
  --data-urlencode 'query=_stream:{kind="access"}' \
  --data-urlencode 'limit=5'
```

**Observe → Requests** appears on an app once it has a domain and the store has
access lines for it from the last 7 days. Until then, the attack card on the
Security tab says **Requests aren't recorded yet** and links here. Orchard
caches the answer for about two minutes, so send a few requests and wait a
moment.

## Client IPs show as hidden

The attack card groups private and cluster addresses (`10/8`, `172.16/12`,
`192.168/16`, `100.64/10`, loopback, link-local) into one row, **Hidden by the
load balancer**, and never reports them as a flood. That row is normal when the
real client address is lost before the ingress controller sees it:

- **The load balancer SNATs traffic.** With `externalTrafficPolicy: Cluster`,
  the default, a node that receives a packet can forward it to an ingress pod on
  another node, and rewrites the source address to do so. Every request then
  comes from a cluster address.
- **A Cloudflare Tunnel.** Every request arrives from `cloudflared` inside the
  cluster.
- **A LAN install.** Clients on the same network really do have private
  addresses.

`externalTrafficPolicy: Local` on the controller's Service keeps the client
address, because traffic only goes to ingress pods on the node that received
it. On Traefik:

```bash
helm upgrade traefik traefik/traefik -n traefik \
  --version <deployed chart version> --reuse-values \
  --set service.spec.externalTrafficPolicy=Local
```

The tradeoff: a node with no ready ingress pod drops the traffic it receives.
With several nodes, run an ingress pod on every node that receives traffic, or
make sure your load balancer only sends to nodes that have one. If one node
announces the address (L2 mode), one flapping ingress pod on that node takes
the whole address down. On a one-box install there is only one node, so this
costs nothing.

Behind a proxy or CDN, the client address is in a header rather than the
connection. HAProxy can use one with `src-ip-header`, for example
`src-ip-header: cf-connecting-ip` behind Cloudflare. Only do that if every
request comes through that proxy: anyone who reaches the load balancer directly
can set the header to whatever they like.
