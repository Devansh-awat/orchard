---
title: Configure logs and request data
description: Configure the Orchard log store and ingress access logs that log search, the Requests view, and attack signals use.
sidebar:
  order: 8
---

Orchard keeps a copy of each app's logs, and of the ingress controller's access log, in a log store inside the cluster. Live logs do not use the store, because they stream from the pods. Features that look back in time need it.

| Feature                                        | Location                                                                            | Needs                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| Search over past logs, levels, context, export | [**Observe** > **Logs**](/run/monitor-an-app/#search-logs)                          | The log store                 |
| Per-route traffic, error rates, and latency    | [**Observe** > **Requests**](/run/monitor-an-app/#inspect-requests)                 | The log store and access logs |
| Attack attempts and top sources                | [**Security** tab](/deploy/security-tab/)                                           | The log store and access logs |
| Error grouping across replaced replicas        | [**Observe** > **Errors**](/run/monitor-an-app/#triage-errors), and deploy verdicts | The log store                 |

Without the store, error grouping uses the logs of the pods that are running now. A deploy verdict can then miss errors from replaced replicas.

## Components

Both components run in the `orchard-metrics` namespace (`metrics.namespace`):

- **VictoriaLogs** is one StatefulSet named `victorialogs`, with one volume.
- **Vector** is a DaemonSet. It reads logs from pods in namespaces labeled `orchard.my/managed=true`, and from ingress controller pods with the label `app.kubernetes.io/name` set to `traefik` or `kubernetes-ingress`.

`logs.enabled` is on by default in the chart and the installer. It is separate from `metrics.enabled`. The chart sets `VICTORIALOGS_URL` on the server when `logs.enabled` is on.

## Retention and disk

Two limits apply. Whichever limit is reached first takes effect.

- `logs.retention` is how long logs are kept. The default is `14d`. The installer writes `7d` on a machine with less than 8 GB of memory.
- `logs.maxDiskSpaceUsage` is the disk limit. Above it, the oldest days are dropped. Keep this value below the volume size.

The installer sizes the volume at a tenth of free disk, between 5 GB and 20 GB, and sets the limit to 80% of that. The chart defaults are a `20Gi` volume and a `16GiB` limit.

To change the limits on an installer host, run the following commands:

```bash
sudo orchardctl config set logs.retention 30d
sudo orchardctl config set logs.maxDiskSpaceUsage 12GiB --apply
```

## Storage class

`logs.victorialogs.storage.storageClass` is empty by default, which uses the cluster's default StorageClass. The installer writes `local-path`.

A StatefulSet cannot change its StorageClass in place. The following behavior prevents failed upgrades:

- When the value is empty, the chart keeps the class of the live `victorialogs` StatefulSet.
- On an installer host, `orchardctl update` checks the volume. If the volume is bound, it pins the values file to the current class. If the volume never bound, it deletes the StatefulSet and its empty claim, and recreates them on the configured class. The same check runs for VictoriaMetrics.

To move a store that holds data to another class, set the value explicitly. The store starts with an empty volume.

## Chart values

| Value                                    | Chart default                                          | Installer, less than 8 GB of memory      |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `logs.enabled`                           | `true`                                                 | `true`                                   |
| `logs.retention`                         | `14d`                                                  | `7d`                                     |
| `logs.maxDiskSpaceUsage`                 | `16GiB`                                                | From free disk                           |
| `logs.victorialogs.image`                | `victoriametrics/victoria-logs:v1.53.0`                |                                          |
| `logs.victorialogs.storage.size`         | `20Gi`                                                 | From free disk                           |
| `logs.victorialogs.storage.storageClass` | Empty, the cluster default                             | `local-path`                             |
| `logs.victorialogs.resources`            | Requests `100m/256Mi`, limits `1/1Gi`                  | Requests `50m/96Mi`, limits `1/384Mi`    |
| `logs.vector.image`                      | `timberio/vector:0.60.0-distroless-libc`               |                                          |
| `logs.vector.dataDir`                    | `/var/lib/vector-orchard`, a host path for checkpoints |                                          |
| `logs.vector.bufferEvents`               | `20000`                                                | `5000`                                   |
| `logs.vector.resources`                  | Requests `50m/128Mi`, limits `500m/512Mi`              | Requests `20m/64Mi`, limits `500m/256Mi` |

On a small machine, reduce these values instead of turning off the store.

## Turn off the log store

On an installer host, run the following command. `orchardctl update` does not turn it back on.

```bash
sudo orchardctl config set logs.enabled false --apply
```

On a Helm install, set `logs.enabled` to `false`.

Live logs keep working. Log search, the Requests view, and the attack card are removed.

## Access logs

The Requests view and the attack card read the ingress controller's access log, with one JSON line for each request. Vector parses Traefik and HAProxy (the haproxytech `kubernetes-ingress` chart). It ignores lines from other controllers.

Orchard removes query strings before it stores a line. It also replaces IDs in paths with `:id`, so `/users/42` and `/users/43` count as one route.

### Traefik

Traefik needs access logging on, JSON format, and the `User-Agent` header kept. Do not drop the `ServiceName` field, because Orchard uses it to match a line to an app.

On an installer host, this setup is automatic. The installer sets these values. `orchardctl update` sets them on a host installed earlier, with `--reuse-values` on the deployed chart version, so Traefik itself does not change version.

On your own cluster, the keys depend on the Traefik chart version:

```bash
helm list -n traefik
```

For chart 41 and later, run the following command:

```bash
helm upgrade traefik traefik/traefik -n traefik \
  --version <DEPLOYED_CHART_VERSION> --reuse-values \
  --set accessLog.enabled=true \
  --set accessLog.format=json \
  --set accessLog.fields.headers.names.User-Agent=keep
```

For earlier charts, run the following command:

```bash
helm upgrade traefik traefik/traefik -n traefik \
  --version <DEPLOYED_CHART_VERSION> --reuse-values \
  --set logs.access.enabled=true \
  --set logs.access.format=json \
  --set logs.access.fields.headers.names.User-Agent=keep
```

`ServiceName` has the form `<namespace>-<service>-<port>@kubernetes`. Orchard matches it against `<namespace>-<app>-<port>`, and `<namespace>-<app>--green-<port>` for the green half of a blue-green deploy. Orchard drops lines for Traefik's `@internal` services.

### HAProxy

HAProxy has no built-in JSON access log, so you must set a format with the field names that Vector reads: `ts_ms`, `host`, `method`, `path`, `status`, `duration_ms`, `bytes`, `client_ip`, `user_agent`, `backend`, and `server`.

Add the following to the `kubernetes-ingress` chart values:

```yaml
controller:
  config:
    syslog-server: 'address:stdout, format: raw, facility:daemon'
    log-format: '%{+json}o %(ts_ms)[request_date(ms)] %(host)[var(txn.host)] %(method)HM %(path)HPO %(status)ST %(duration_ms)Ta %(bytes)B %(client_ip)ci %(user_agent)[var(txn.ua)] %(backend)b %(server)s'
    frontend-config-snippet: |
      http-request set-var(txn.host) req.hdr(host)
      http-request set-var(txn.ua) req.fhdr(user-agent)
```

- The snippet captures the host and user agent, because the log format cannot read request headers directly. `req.fhdr` keeps commas inside the user agent.
- Keep the `syslog-server` line. Without it, the controller reloads HAProxy about once a minute. Each reload refuses long-lived HTTP/2 streams, which browsers report as `ERR_HTTP2_SERVER_REFUSED_STREAM`.
- Orchard uses the backend name, `<namespace>_svc_<service>_<port>`, to match a line to an app.
- The stdout target cuts lines at 1024 bytes. A request with a very long path or user agent produces broken JSON, and Orchard drops it.

### Verify access logs

1. Check the controller's output. Each line should be a JSON object.

   ```bash
   kubectl -n traefik logs deploy/traefik --tail=3
   ```

2. Check that the store has access lines:

   ```bash
   kubectl -n orchard-metrics port-forward svc/victorialogs 9428:9428 &
   curl -s http://127.0.0.1:9428/select/logsql/query \
     --data-urlencode 'query=_stream:{kind="access"}' \
     --data-urlencode 'limit=5'
   ```

**Observe** > **Requests** appears on an app when it has a domain and the store has access lines for it from the last seven days. Until then, the attack card on the **Security** tab shows **Requests aren't recorded yet**. Orchard caches this answer for about two minutes.

## Client IPs show as hidden

The attack card groups private and cluster addresses (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, loopback, and link-local) into one row, **Hidden by the load balancer**. It does not report them as a flood.

This row appears when the client address is lost before the ingress controller sees it:

- **The load balancer uses source NAT:** With `externalTrafficPolicy: Cluster`, the default, a node can forward a packet to an ingress pod on another node, and it rewrites the source address.
- **A Cloudflare Tunnel:** Every request arrives from `cloudflared` inside the cluster.
- **A LAN install:** Clients on the same network have private addresses.

To keep the client address, set `externalTrafficPolicy: Local` on the controller's Service. On Traefik, run the following command:

```bash
helm upgrade traefik traefik/traefik -n traefik \
  --version <DEPLOYED_CHART_VERSION> --reuse-values \
  --set service.spec.externalTrafficPolicy=Local
```

With this setting, a node with no ready ingress pod drops the traffic it receives. Run an ingress pod on each node that receives traffic. If one node announces the address (L2 mode), one failing ingress pod on that node takes the address down. A single-machine install has no extra risk.

Behind a proxy or CDN, the client address is in a header. HAProxy can read one with `src-ip-header`, such as `src-ip-header: cf-connecting-ip` behind Cloudflare. Use this only if every request comes through that proxy. Anyone who reaches the load balancer directly can set the header to any value.

## Related resources

- [Read logs and open a shell](/run/logs/)
- [Metrics and alerts](/run/observability/)
- [Host commands](/operate/host-commands/)
- [Monitor an app](/run/monitor-an-app/)
