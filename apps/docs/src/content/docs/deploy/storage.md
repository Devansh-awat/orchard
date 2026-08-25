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
