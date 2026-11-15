---
title: Scale the control plane
description: Reduce the memory the Orchard control plane uses on a small cluster, autoscale the server and frontend, and keep pod shells working across replicas.
sidebar:
  order: 5
---

To fit Orchard on a small cluster or to handle more traffic, change how much the control plane requests and how many pods it runs.

## Reduce the metrics stack

The bundled metrics stack is VictoriaMetrics, vmagent, kube-state-metrics, and node-exporter. It is the largest cost at idle. VictoriaMetrics sizes its cache as a share of its memory limit, so it grows to fill the limit.

To turn the stack off, set the following value. The metrics graphs and the usage pages are then empty. Everything else keeps working.

```yaml
metrics:
  enabled: false
```

To keep the stack and make it smaller, lower `metrics.victoriametrics.resources.limits.memory` and `metrics.victoriametrics.memoryAllowedPercent`.

On an installer host, the installer lowers these values on a machine with less than 8 GiB of RAM. To leave the stack out, pass `--metrics false`.

## Autoscale the server and frontend

The server and frontend can scale on CPU instead of running a fixed number of replicas. This needs metrics-server, which k3s includes.

```yaml
server:
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 8 }
frontend:
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 6 }
```

Autoscaling reacts to a burst after 60 seconds and removes capacity after 5 minutes. When autoscaling is on, the chart leaves `replicas` out of that Deployment, so Orchard ignores `replicas` in your values for that tier.

## Move builds to their own pods

`server.workers.enabled: true` moves builds and the apply queue onto worker pods. Workers have their own `server.workers.autoscaling` block.

## Run more than one server replica

More than one replica needs Redis. The chart runs Redis and sets `REDIS_URL` by default, and runs two server replicas. If you turn off the chart's Redis, set `REDIS_URL` to your own. For what depends on it, refer to [Rate limits and client addresses](/operate/client-addresses/) and [Replicas and leases](/operate/architecture/#replicas-and-leases).

### Pod shells across replicas

A pod shell in the dashboard is a session that the server pod that opened it holds in memory. If the browser disconnects, the session stays open for `EXEC_DETACH_GRACE_MS`, which is 10 minutes by default, and the same tab reconnects to it.

With more than one replica, a reconnect can reach a pod that does not hold the session. That pod finds the session in Redis and proxies the connection to the pod that holds it. To turn this off, set `EXEC_SESSION_PROXY=false`. The browser then gets a new shell.

Sessions do not survive the replacement of the server pod during an upgrade.

## Related resources

- [Architecture](/operate/architecture/) - Review the components of an instance and how replicas share work.
- [Turn resource limits on or off](/operate/resource-limits/) - Choose whether apps and databases are held to CPU and memory limits.
- [Run on a small server](/operate/small-servers/) - Learn what the installer trims on a machine with little memory.
