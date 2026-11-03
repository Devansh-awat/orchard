# Database disaster recovery

Every Orchard database is a CNPG cluster that streams its WAL to object storage and takes a base backup every night. Anything inside the 30 day window can be brought back to any second, as long as the bucket survives. This page is the order of operations for each kind of loss, smallest first.

## What exists where

| Thing | Where | Survives losing the cluster? |
|---|---|---|
| Tenant base backups and WAL | `s3://<bucket>/<namespace>/<cluster>/<serverName>/` | yes |
| Deleted databases | same prefix, kept 30 days, listed in `deleted_databases` | yes |
| Catalog of every archive | `s3://<platform bucket>/_catalog/databases-latest.json` (and one per day) | yes |
| Orchard's own database | `postgres.backup.*` in the chart, written straight to the bucket, not through r2-proxy | yes, once enabled |
| Databases outside CNPG (Harbor) | `databaseDumps.targets` in the chart, nightly `pg_dump` under `platform-dumps/` | yes, once enabled |
| Checkpoints | restore points inside the WAL stream, listed in `database_checkpoints` | the points yes, the list only with orchard-db |

Restore tests (`DB_RESTORE_DRILLS` or the admin toggle) restore every database into `orchard-restore-drills` once a week and fail loudly in notifications and Datadog (`orchard.cnpg.restore_test_failing`, `orchard.cnpg.days_since_restore_test`). If those are green, the steps below work.

## One database: bad data, bad migration, dropped table

Use the product. In the database's Backups tab, or:

```
orchard db checkpoint list <id>
orchard db backup restore <id> --checkpoint <checkpointId> --wait
orchard db backup restore <id> --at 2026-10-31T09:41:00Z --wait
```

An in-place restore checkpoints first and keeps the previous copy stopped for 24 hours. `orchard db ops undo <operationId>` swaps back. To look before replacing anything, add `--fork` and inspect the copy.

Every `DROP TABLE`, `DROP SCHEMA` and `ALTER TABLE ... DROP COLUMN` takes a checkpoint automatically, and so does every deploy of an app bound to the database. A rollback with "also restore databases" goes back to the checkpoint from before that deploy.

## One database: deleted

It sits in the trash for 30 days. Project page, Recently deleted, Bring back, or `orchard db trash restore <id>`. It comes back with the same credentials into the same environment (or the default one if that environment is gone).

## A namespace or environment deleted in Kubernetes

The teardown keeps the backups. Bring each database back from the trash as above. If the rows are gone too, use the catalog (next section).

## The Kubernetes cluster is gone

1. Build the new cluster and install CNPG, the barman cloud plugin and cert-manager.
2. Restore Orchard's own database first. Create a Cluster named `orchard-db` with `bootstrap.recovery` from the orchard-db archive (`postgres.backup.destinationPath`, server name `orchard-db`), then install the chart. Orchard comes back knowing every database, checkpoint and trash entry.
3. For each tenant database, use the Backups tab or `orchard db backup restore <id> --wait`. Restores read the archive straight from the bucket and need nothing that lived in the old cluster.
4. If orchard-db itself cannot be restored, download `_catalog/databases-latest.json`. Each entry has `destinationPath`, `serverName`, `pgMajor`, `dbName` and `dbUser`, which is everything a recovery Cluster needs:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: <clusterName>, namespace: <namespace> }
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:<pgMajor>
  storage: { size: <storageSize> }
  bootstrap:
    recovery:
      source: origin
      database: <dbName>
      owner: <dbUser>
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters: { barmanObjectName: origin-store, serverName: <serverName> }
```

with an ObjectStore `origin-store` whose `destinationPath` is the entry's `destinationPath` and whose credentials can read the bucket.

## The bucket is gone

Nothing in Orchard can bring the data back from that. Keep bucket versioning or a second copy (another provider, or R2 bucket lock) for this case.

## Operator notes

- Plugin migration: upgrade CNPG to 1.30 one minor at a time with `ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES` on, install plugin-barman-cloud, set `CNPG_BARMAN_PLUGIN=on` on the server, then turn on "Move backups to the Barman Cloud plugin" in admin. It moves a few clusters every 10 minutes, keeps their archive path and server name so old backups stay restorable, skips namespaces without quota headroom for the sidecar, and halts itself if a moved cluster stops archiving.
- Every restore, fork, undelete and restore test is a row in `database_operations` that the leader drives every 10 seconds. A server restart resumes them.
