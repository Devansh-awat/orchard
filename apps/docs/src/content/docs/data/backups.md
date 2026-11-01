---
title: Backups and restore
description: Where backups go, checkpoints, point-in-time restore, forks, the trash and restore tests.
sidebar:
  order: 2
---

## Where backups go

Backups go to S3-compatible object storage. There are two places it can come
from, and an organization's own always wins:

- **The organization's own bucket**: an endpoint, bucket and credentials under
  **Organization settings → Backups**.
- **The instance's backup bucket**, set by an operator. See
  [Backup storage for operators](#backup-storage-for-operators) below.

With either in place, every managed database archives write-ahead log (WAL)
continuously and takes a nightly base backup on its own. Databases created
before the bucket existed are brought in by the platform within a few hours,
without touching anything an organization configured itself.

Without either, the database's **Backups** tab says **Backups need storage**,
and checkpoints, the drop guard and restore tests are unavailable. Their
switches under **Settings → Protection** are greyed out with the reason.

## Taking backups

The **Backups** tab lists every backup with its size and age, and takes one on
demand. A **schedule** runs them automatically; set it once and the operator
handles the rest.

## Checkpoints

A checkpoint is a named restore point: a marker in the WAL you can restore to
later. Taking one is quick, about a second, and does not copy any data. Take one
from the Backups tab before anything risky, or for a whole project at once.

Orchard also takes them on its own:

- **Before a drop.** With **Checkpoint before drops** on, a guard inside the
  database takes one before any `DROP TABLE`, `DROP SCHEMA` or `DROP COLUMN`
  runs, and records what was dropped and by whom. `TRUNCATE` is not covered.
- **Before a deploy**, so a rollback can offer to put the app's databases back
  as well.
- **Before an operation** that changes the database, such as an in-place
  restore or a major upgrade.

A checkpoint shows as pending until the WAL holding it has reached object
storage, then as restorable. Checkpoints expire after 30 days, with the backups
they depend on.

## Restoring

Restore from a backup, a checkpoint, or any moment in time between the oldest
backup and now (point-in-time restore). There are two ways to do it:

- **Copy into a new database** (a fork). The original is untouched, so you can
  compare the two before switching your app's connection string over. A fork
  keeps the source's database name, so an app pointed at it finds its tables.
  Forking from **Now** copies the live database instead of replaying a backup.
- **Replace this database.** Orchard takes a checkpoint first, then swaps the
  restored copy in. The previous copy is kept stopped for 24 hours, and **Undo
  this restore** swaps it back.

You can also start a brand new database from an existing one at creation time,
which is the easiest way to clone production into a staging copy.

## Deleted databases

Deleting a database moves it to **Recently deleted** in the project for 30
days, where it can be restored. Only a database that had at least one completed
backup can come back, because recovery replays that backup. After 30 days it is
purged.

Turn on **Deletion protection** under **Settings → Protection** and delete is
refused until someone turns it off again.

## Restore tests

A restore test restores the latest backup into a throwaway copy, checks that
the tables and row counts match, and deletes the copy. It is the only way to
know a backup actually restores. Run one from the Backups tab, or turn on
**Weekly restore tests** under **Settings → Protection**. A failed test sends a
notification.

Superadmins set the instance-wide defaults under **Instance admin → Configuration → Databases**:
checkpoints before drops are on by default, weekly restore tests are off.

## What to verify

:::caution
Archiving write-ahead logs is not the same as having a backup. WAL is a stream of
changes that has to be replayed **onto a base backup**; if no base backup was ever
taken, the archived WAL cannot restore anything on its own, and a deleted
database is unrecoverable.

If you rely on backups, take one now and run a restore test to prove the whole
path works. An untested backup is a hypothesis.
:::

Check `firstRecoverabilityPoint` on the database: if it is empty, no base backup
has ever completed, whatever the schedule says.

## Where a backup runs

The base backup runs inside the database's own container, sharing its memory
limit with Postgres. That is why compression is chosen from the memory limit
rather than always being on: on a small database, compressing the backup can use
enough memory to get Postgres OOMKilled, which fails the backup, which retries,
which kills it again.

You can force it either way from the **Settings** tab if you have a reason to.
Write-ahead log archiving is compressed regardless, since it works one segment at
a time and fits in any budget.

## Retention

Orchard keeps 30 days of backups and WAL for each database, and removes older
ones itself. That is also how far back point-in-time restore and checkpoints
reach. If your bucket has its own lifecycle rule, keep it longer than 30 days,
or it deletes backups Orchard still counts on.

## Backup storage for operators

The instance's backup target needs all of:

| Variable               | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `R2_BACKUP_BUCKET`     | the bucket backups are written to                                |
| `R2_ENDPOINT`          | the S3 endpoint; derived from `R2_ACCOUNT_ID` on R2              |
| `R2_ACCESS_KEY_ID`     | access key                                                       |
| `R2_SECRET_ACCESS_KEY` | secret key                                                       |
| `R2_REGION`            | optional, the region requests are signed with; `auto` by default |

They can also be set under **Instance admin → Configuration → Object storage**, except
`R2_REGION`, which is environment only. Any S3-compatible store works.

`R2_BUCKET_NAME`, the general bucket for uploads and assets, is **never** used
for backups. It may be public, and backups must not be. Setting only
`R2_BUCKET_NAME` leaves databases with no backups at all.

On a chart install, also point the backup proxy at the same store, so each
database gets credentials for its own prefix rather than the instance's key:

```yaml
r2Proxy:
  enabled: true
  defaultBucket: my-backups
  upstream:
    endpoint: https://<account>.r2.cloudflarestorage.com
    region: auto
    accessKey: <key id>
    secretKey: <secret>
```

### The local store on self-hosted installs

The one-command installer runs an S3 store inside the cluster (versitygw, in
the `orchard-object-storage` namespace) together with the backup proxy, and
points the instance's backups at it. Checkpoints, point-in-time restore, forks,
the trash and restore tests all work from the first database. `orchardctl
update` turns it on for an older host, but only when no object storage is
configured anywhere: not in the values file, not in `server.envFrom`, not in
`r2Proxy.upstream`, and not under Instance admin.

:::caution
The local store is **not disaster recovery**. The backups sit on the same
machine, usually the same disk, as the databases they protect. They undo a bad
migration or a dropped table. They do not survive losing the disk or the box.
:::

Its chart keys are under `objectStorage.local.*`: `enabled`, `bucket`
(`orchard-backups`), `storage.size` (the installer gives it a fifth of free
disk, between 5G and 50G) and `storage.storageClass`. `local-path` does not
enforce the size, so watch the disk. Install without it with
`--object-storage false`; databases then have no backups until you configure
storage.

### Moving to real S3 or R2

Every existing database's backup configuration names the bucket, and the proxy
only serves the bucket it is configured with. So keep the bucket name, and copy
what is already there before switching, or point-in-time restore loses
everything from before the switch.

1. Create a bucket with the same name as `objectStorage.local.bucket`
   (`orchard-backups` unless you changed it), and a key that can list, read,
   write and delete in it.
2. Copy the existing backups across. From the host, with the AWS CLI installed:

   ```bash
   kubectl -n orchard-object-storage port-forward svc/object-storage 9000:9000 &
   export AWS_ACCESS_KEY_ID=$(kubectl -n orchard get secret orchard-object-storage -o jsonpath='{.data.accessKey}' | base64 -d)
   export AWS_SECRET_ACCESS_KEY=$(kubectl -n orchard get secret orchard-object-storage -o jsonpath='{.data.secretKey}' | base64 -d)
   aws --endpoint-url http://127.0.0.1:9000 --region auto s3 sync s3://orchard-backups ./orchard-backups
   AWS_ACCESS_KEY_ID=<key id> AWS_SECRET_ACCESS_KEY=<secret> \
     aws --endpoint-url https://<account>.r2.cloudflarestorage.com --region auto \
     s3 sync ./orchard-backups s3://orchard-backups
   ```

3. Point the instance and the backup proxy at it, and turn the local store off:

   ```bash
   sudo orchardctl config set r2Proxy.upstream.endpoint https://<account>.r2.cloudflarestorage.com
   sudo orchardctl config set r2Proxy.upstream.region auto
   sudo orchardctl config set r2Proxy.upstream.accessKey <key id>
   sudo orchardctl config set r2Proxy.upstream.secretKey <secret>
   sudo orchardctl config set r2Proxy.defaultBucket orchard-backups
   sudo orchardctl config set objectStorage.local.enabled false
   sudo orchardctl env set R2_ENDPOINT https://<account>.r2.cloudflarestorage.com
   sudo orchardctl env set R2_ACCESS_KEY_ID <key id>
   sudo orchardctl env set R2_SECRET_ACCESS_KEY <secret>
   sudo orchardctl env set R2_BACKUP_BUCKET orchard-backups --apply
   ```

   On a plain Helm install, set the same keys in your values file.

4. WAL written between the copy and the switch exists only in the local store,
   so take a fresh checkpoint of each database afterwards. The local volume is
   kept (`object-storage-data` in `orchard-object-storage`). Delete it yourself
   once those checkpoints are older than anything you would restore to.
