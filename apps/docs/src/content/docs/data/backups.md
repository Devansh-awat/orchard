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

## Retention

Backups accumulate until something removes them. Set a retention policy in your
object storage if you do not want to pay for every backup you have ever taken.
