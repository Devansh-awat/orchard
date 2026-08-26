---
title: Troubleshooting
description: The failures that actually happen, and what they mean.
sidebar:
  order: 5
---

## Builds

**Build fails immediately with a missing module or command.** The wrong build
stage. A multi-stage Dockerfile built at its first stage produces an image
without the application. Set the build stage to the final one.

**Build fails deep in a layer with an I/O error.** Cache or disk pressure on the
builder.

**A push fails fast with a rate-limit-looking error.** Read the BuildKit
container's logs rather than the pusher's. A quick failure there is usually the
build daemon dying and the pusher reporting the aftermath.

## Apps

**CrashLoopBackOff.** Read the crash report on the app, which includes the logs of
the container that already died. The first line of the stack trace is nearly
always the answer.

**Exit 137.** Out of memory. Raise the memory limit or fix the leak. Requests
equal limits here, so the limit is exactly what you chose.

**Running but never ready.** The health check is pointing at the wrong path or
port, or the app takes longer to start than the check allows.

**Cannot reach another app.** Use the internal cluster address shown under the
port, not the public URL. Traffic between apps should not leave the cluster.

## Databases

**Application cannot connect.** Check you used the internal host and the `-rw`
endpoint. Reads sent to `-ro` work; writes do not.

**Stale reads.** Replicas are asynchronous. Anything that reads its own writes
must use `-rw`.

**Restore produced an empty database.** Confirm a base backup exists. Archived
write-ahead logs alone cannot restore anything. `firstRecoverabilityPoint` on the
database is the quick check: empty means no base backup has ever completed,
whatever the schedule says.

**Database restarts every few minutes.** Look at the last termination reason. An
`OOMKilled` on a loop that lines up with the backup window means the backup
itself is running out of room: the base backup runs inside the database
container and shares its memory limit. Raise memory, and check that
`shared_buffers` is not set close to that limit by hand, since it is reserved up
front and leaves nothing for anything else. Leaving `shared_buffers` empty lets
Orchard size it.

**Database page shows one replica and no pods.** The instance is not running.
When the storage volume is listed as dangling, Kubernetes will not recreate the
pod on its own and an administrator needs to look at the cluster.

## Domains

**Certificate never issues.** DNS is not resolving to the instance yet. Orchard
validates the record before requesting a certificate, so the error names the
problem.

**A webhook gets a login page.** The app is protected and the webhook path is not
in the public paths list.

## The platform

**The dashboard is slow or stale.** Reads come from the mirror. If it disagrees
with the cluster, the cluster wins; the mirror reconciles. Persistent staleness
is worth reporting with the app id.

**A deploy is queued and not moving.** Writes go through a retrying apply queue.
A conflict retries rather than failing, so a stuck queue usually means the
cluster is rejecting the write for a reason worth reading in the events.

## Getting the detail

```bash
kubectl -n orchard logs deploy/server --tail=200
kubectl -n <tenant-namespace> get events --sort-by=.lastTimestamp
```
