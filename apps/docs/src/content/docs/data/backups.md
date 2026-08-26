---
title: Backups and restore
description: Scheduled backups, on-demand backups, and restoring into a new database.
sidebar:
  order: 2
---

## Taking backups

The **Backups** tab lists every backup with its size and age, and takes one on
demand. A **schedule** runs them automatically; set it once and the operator
handles the rest.

Backups go to object storage configured per organization (an S3-compatible
endpoint, bucket and credentials). Without that configured, there is nowhere to
put them.

## Restoring

Restore creates a **new** database from a backup rather than overwriting the
existing one. That means a restore is non-destructive and you can compare the two
before switching your app's connection string over.

You can also restore into a brand new database at creation time, via **Restore
from existing database**, which is the easiest way to clone production into a
staging copy.

## What to verify

:::caution
Archiving write-ahead logs is not the same as having a backup. WAL is a stream of
changes that has to be replayed **onto a base backup**; if no base backup was ever
taken, the archived WAL cannot restore anything on its own, and a deleted
database is unrecoverable.

If you rely on backups, take one now and restore it into a new database to prove
the whole path works. An untested backup is a hypothesis.
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

Backups accumulate until something removes them. Set a retention policy in your
object storage if you do not want to pay for every backup you have ever taken.
