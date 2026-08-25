---
title: Databases
description: Managed PostgreSQL that lives next to your app.
sidebar:
  order: 1
---

**New → Database** creates a managed PostgreSQL instance in a project. Orchard
runs it as a CloudNativePG cluster, so failover, storage and backups are handled
by an operator rather than a script.

## Connecting

The **Connection** tab has everything, in four formats:

| Format | For                              |
| ------ | -------------------------------- |
| `URI`  | Most libraries and ORMs          |
| `psql` | A terminal                       |
| `.env` | Dropping into an app's variables |
| `JDBC` | JVM applications                 |

The password is masked until you reveal it, and every field has a copy button.

**Use the internal host.** The connection host is a cluster-internal address
(`pg-<name>-rw.<namespace>.svc.cluster.local`). Traffic to it stays inside the
cluster: no ingress hop, no public DNS, no TLS termination in the middle. Apps in
the same project should always use this.

The `-rw` suffix is the read-write endpoint. With [read replicas](/data/replicas/)
there is a matching read-only endpoint.

## Sizing

Storage size is set at creation and can grow later; it cannot shrink. CPU and
memory are set on the **Resources** tab like any other workload.

## The other tabs

- **Backups** — scheduled and on-demand, with restore. See [Backups](/data/backups/).
- **Terminal** — a `psql` session in the browser.
- **Extensions** — install and remove, see [Extensions](/data/extensions/).
- **Queries** — run SQL and read the result.
- **Metrics** — size, connections, and activity over time.
- **Settings** — rename, resize, delete.

## Public access

By default a database is reachable only from inside the cluster, which is the
right default. **Enable** public access assigns a port on the organization's
shared database IP so you can connect from your laptop or a BI tool.

This needs an L4 load balancer, and a shared database IP configured for the
organization. It is unavailable in Cloudflare Tunnel mode, because tunnels carry
HTTP only.

Turning it on exposes a database to the internet. Use a strong password, and turn
it off when you are done.

## Deleting

Deleting a database deletes its storage.

:::danger
Check that a backup you can actually restore from exists before deleting anything
you care about. Write-ahead log archiving alone is not a backup: without a base
backup to replay onto, archived WAL cannot be restored.
:::
