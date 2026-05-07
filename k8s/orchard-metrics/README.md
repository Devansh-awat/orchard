# orchard-metrics

Self-hosted, PromQL-compatible metrics for Orchard.

```
                       ┌─────────────────────┐
                       │   kubelet (per node)│  → /metrics/cadvisor
                       │   node-exporter     │  → :9100/metrics
                       │   kube-state-metrics│  → :8080/metrics
                       │   opt-in pods       │  → prometheus.io/scrape=true
                       └──────────┬──────────┘
                                  │ scrape (30s)
                                  ▼
                          ┌──────────────┐
                          │   vmagent    │
                          └──────┬───────┘
                                 │ remote-write
                                 ▼
                       ┌─────────────────────┐
                       │  VictoriaMetrics    │  PromQL HTTP API :8428
                       │  retention=30d      │  PVC=5Gi (longhorn)
                       └─────────────────────┘
                                  ▲
                                  │ /api/v1/query_range
                          Orchard backend
```

## Why VictoriaMetrics

- PromQL-compatible (drop-in replacement for Prometheus's query API)
- ~7× better disk compression than Prometheus → more retention per Gi
- Hard retention cap (`-retentionPeriod=30d`) — old data is purged on a fixed schedule, never grows forever
- Halts ingest before disk fills (`-storage.minFreeDiskSpaceBytes=512MB`)
- Single static binary, fast cold-start, very fast queries (the snappy
  Datadog-feel comes from this)

## Files

| File                          | Contents                                                |
| ----------------------------- | ------------------------------------------------------- |
| `00-namespace.yaml`           | namespace + privileged PSA label                        |
| `10-victoriametrics.yaml`     | VMSingle StatefulSet + Service (port 8428)              |
| `20-rbac.yaml`                | SA + ClusterRole/Binding for vmagent + kube-state-metrics |
| `21-kube-state-metrics.yaml`  | KSM Deployment + Service (cluster-state metrics)        |
| `22-node-exporter.yaml`       | DaemonSet + headless Service (node-level metrics)       |
| `23-vmagent.yaml`             | vmagent Deployment + scrape ConfigMap                   |
| `30-network-policies.yaml`    | default-deny + targeted allows                          |

## Deploy from scratch

```bash
kubectl apply -f .
```

That's it — no secret bootstrapping, no externally generated passwords.
The whole stack converges in ~60 seconds.

## Smoke test

```bash
# Should return ~30 targets, all up
curl -sS 'http://victoriametrics.orchard-metrics.svc.cluster.local:8428/api/v1/query?query=up' | jq '.data.result | length'

# Cross-namespace coverage (the bug that killed the OTel attempt)
curl -sS 'http://victoriametrics.orchard-metrics.svc.cluster.local:8428/api/v1/query' \
  --data-urlencode "query=count by (namespace) (container_cpu_usage_seconds_total{container!='',container!='POD'})" | jq
```

## Useful PromQL

```promql
# CPU (millicores) for a deployment
sum(rate(container_cpu_usage_seconds_total{namespace="<ns>",pod=~"<dep>-.*",container!="",container!="POD"}[1m])) * 1000

# Memory (bytes)
sum(container_memory_working_set_bytes{namespace="<ns>",pod=~"<dep>-.*",container!="",container!="POD"})

# Network in/out (bytes/sec)
sum(rate(container_network_receive_bytes_total{namespace="<ns>",pod=~"<dep>-.*"}[1m]))
sum(rate(container_network_transmit_bytes_total{namespace="<ns>",pod=~"<dep>-.*"}[1m]))

# Cluster-state — replica health
kube_deployment_status_replicas_available{namespace="<ns>",deployment="<dep>"}
  / kube_deployment_spec_replicas{namespace="<ns>",deployment="<dep>"}
```

## Backend wiring

The Orchard backend reads `VICTORIAMETRICS_URL` from `.env`:

```
VICTORIAMETRICS_URL=http://victoriametrics.orchard-metrics.svc.cluster.local:8428
```

`server/src/metrics/metrics.service.ts` issues `query_range` requests for
the four cards (CPU, memory, rx, tx) and returns them in the
`SeriesBundle` shape the frontend expects.

## Adding app metrics

Any pod with these annotations gets scraped automatically by the
`kubernetes-pods` job:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9090"
    prometheus.io/path: "/metrics"  # optional, defaults to /metrics
```

## Capacity & retention

- 5Gi PVC, 30d retention → comfortable headroom for a ~200-pod cluster
- ~30 cardinality-controlled cAdvisor series per pod (the rest are
  dropped at scrape time via `metric_relabel_configs` to keep storage
  predictable)
- Bump `storage` in `10-victoriametrics.yaml` and `-retentionPeriod` in
  the same file if you want longer history

## Scaling up (if/when needed)

This is single-node VictoriaMetrics. When you outgrow it:

- Run vmagent as a DaemonSet (one scraper per node, sharded by hash) for
  ingest scale-out
- Replace VMSingle with VMCluster (vmstorage/vmselect/vminsert) for
  horizontal storage and query

Single-node should comfortably handle this cluster's foreseeable growth.
