---
title: Storage
description: Volumes that survive restarts and redeploys.
sidebar:
  order: 6
---

By default a container's filesystem is thrown away when the pod restarts. Attach
storage when files need to outlive that.

**Add storage** on the app takes a mount path and a size, and creates a
PersistentVolumeClaim backed by the cluster's storage class.

## Things worth knowing

**A volume ties an app to one replica** unless the storage class supports
multiple simultaneous writers. Most do not. If you scale an app with a
single-writer volume past one replica, the extra pods will not start.

**Resizing is one-way.** Volumes can grow, not shrink, and only if the storage
class allows expansion.

**Databases do not need this.** A managed database has its own storage. Attach
volumes for uploads, caches, and generated files that belong to the app itself.

**Back it up yourself.** Managed databases have scheduled backups; app volumes do
not. If the contents matter, write them somewhere durable, or use object storage
rather than a volume.

**Attaching one during a build is safe.** The volume is recorded immediately and
applied to whatever the build produces, so a volume added while a build is in
flight still reaches the pod that build creates. Every rebuild also re-checks
the running pod against the configured volumes and repairs a mismatch.

**Check the mount before you trust it with data.** A path that is mounted shows
what the volume holds; a path that is not is ordinary container storage that
disappears with the pod, and it looks identical from inside the app until the
pod restarts. An empty ext4 volume has a `lost+found` directory in it, which is
a quick way to tell the two apart.
