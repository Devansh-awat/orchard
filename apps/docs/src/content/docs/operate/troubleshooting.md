---
title: Troubleshooting Orchard
description: Fix common Orchard failures with builds, apps, databases, domains, sign-in and the platform, listed by symptom.
sidebar:
  order: 5
---

Use this page to fix common failures on an Orchard instance. Each entry lists the symptom, the cause and the fix.

## Builds

### Image builds need a container registry

```txt
Image builds need a container registry, but DOCKER_REGISTRY_PUSH and DOCKER_REGISTRY_PULL are not set
```

**Cause:** The instance has no registry configured. This occurs on a Helm install without registry values.

**Fix:** Set `DOCKER_REGISTRY_PUSH` and `DOCKER_REGISTRY_PULL` on the server. For more information, refer to [Using your own registry](/operate/finishing-setup/#using-your-own-registry).

### A build succeeds and then the push fails

```txt
dial tcp 203.0.113.10:443: connect: connection refused
```

**Cause:** A network policy blocks the builder from reaching the registry. Builders can only reach DNS, public IP addresses on ports 80 and 443, and the destinations in `builders.registryEgress`.

**Fix:** Add the registry to `builders.registryEgress`. For more information, refer to [Using your own registry](/operate/finishing-setup/#using-your-own-registry).

### Build fails with a missing module or command

**Cause:** The build targets the wrong stage. A multi-stage Dockerfile built at its first stage produces an image without the application.

**Fix:** Set the build stage to the final stage.

### Build fails in a layer with an I/O error

**Cause:** The builder has cache or disk pressure.

**Fix:** Check free disk on the build node and the size of the build cache volume.

### A push fails quickly with an error that looks like a rate limit

**Cause:** The BuildKit daemon stopped, and the pusher reports the result.

**Fix:** Read the logs of the `buildkit` container rather than the pusher:

```bash
kubectl -n orchard-builders logs job/<BUILD_JOB_NAME> -c buildkit --tail=30
```

### Could not schedule build pod

```txt
Build failed: could not schedule build pod after 300s - 0/1 nodes are available: 1 Insufficient memory.
```

**Cause:** No node has enough unreserved memory. The scheduler uses memory requests, not real usage.

**Fix:** Reduce the memory that apps and databases request, or add a node. For more information, refer to [Manage nodes and pools](/operate/nodes/).

## Apps

### CrashLoopBackOff

**Cause:** The app exits soon after it starts.

**Fix:** Read the crash report on the app. It includes the logs of the container that stopped.

### Exit code 137

**Cause:** The container ran out of memory.

**Fix:** Raise the memory limit of the app, or fix the leak.

### Running but never ready

**Cause:** The health check uses the wrong path or port, or the app starts more slowly than the check allows.

**Fix:** Correct the health check, or give it a longer start time.

### One app cannot reach another

**Cause:** The request uses the public URL.

**Fix:** Use the internal cluster address shown under the port.

## Databases

### Instance Status Extraction Error

**Cause:** The tenant network policy blocks the CloudNativePG operator from reaching database pods. The server allows the namespace in `CNPG_OPERATOR_NAMESPACE`, which defaults to `postgresql`.

**Fix:** Set `CNPG_OPERATOR_NAMESPACE` in `server.env` to the namespace where the operator runs, such as `cnpg-system`. The installer sets this for you.

### No backup storage

```txt
No backup storage: configure it for this organization, or set a backup bucket on the instance
```

**Cause:** The instance has no backup bucket. This occurs on a Helm install without object storage.

**Fix:** Refer to [Configure database backups](/operate/finishing-setup/#configure-database-backups).

### An application cannot connect

**Cause:** The connection uses the wrong host or endpoint.

**Fix:** Use the internal host and the `-rw` endpoint. The `-ro` endpoint only accepts reads.

### Reads return old data

**Cause:** Replicas are asynchronous.

**Fix:** Send reads that must see the latest writes to `-rw`.

### A restore produces an empty database

**Cause:** No base backup exists. Archived write-ahead logs alone cannot restore a database.

**Fix:** Check how far back the database can be restored:

```bash
orchard db recovery <DATABASE_ID>
```

### A database restarts every few minutes

**Cause:** The container is out of memory. If the restarts line up with the backup window, the base backup uses memory from the same container.

**Fix:** Read the last termination reason. Raise the memory of the database. Do not set `shared_buffers` close to the memory limit. If you leave `shared_buffers` empty, Orchard sizes it.

### The database page shows one replica and no pods

**Cause:** The instance is not running. If the page lists the storage volume as dangling, Kubernetes does not recreate the pod.

**Fix:** An administrator must inspect the cluster:

```bash
kubectl -n <NAMESPACE> get pods,pvc
```

## Domains

### A certificate never issues

**Cause:** One of the following:

- DNS does not resolve to the instance yet. Check [Point DNS at this instance](/operate/finishing-setup/#point-dns-at-this-instance).
- The ingress controller cannot reach the ACME solver. Check [Letting the ingress controller reach apps](/operate/finishing-setup/#letting-the-ingress-controller-reach-apps).

**Fix:** Correct the cause, then check the challenge:

```bash
kubectl get challenges -A
```

### A webhook receives a login page

**Cause:** The app is protected and the webhook path is not a public path.

**Fix:** Add the path to the public paths list. For more information, refer to [Protection](/deploy/protection/).

## Sign-in

### No option to sign in with an email code

**Cause:** The instance has no email configured, so Orchard hides email codes.

**Fix:** On the host, run `sudo orchardctl login` or `sudo orchardctl password set`. To add email, refer to [Set up email](/operate/finishing-setup/#set-up-email).

## The platform

### The dashboard returns a 404 at a name that resolves to the host

**Cause:** Traefik routes by `Host` header and does not know the name.

**Fix:** List the names, then add the missing one:

```bash
sudo orchardctl hostname
sudo orchardctl hostname add mango --apply
```

### A LAN install does not respond at its sslip.io name

**Cause:** `sslip.io` is public DNS that maps a name to the address inside it. Some resolvers, such as the Tailscale resolver, do not return private addresses.

**Fix:** Use one of the machine's addresses, or add a name that you control:

```bash
sudo orchardctl hostname add mango --apply
sudo orchardctl claim --url mango
```

### A deploy is queued and does not move

**Cause:** The cluster rejects the write, and the apply queue retries it.

**Fix:** Read the events in the tenant namespace:

```bash
kubectl -n <TENANT_NAMESPACE> get events --sort-by=.lastTimestamp
```

## Still stuck?

Collect the following before you ask for help:

```bash
kubectl -n orchard logs deploy/server --tail=200
kubectl -n <TENANT_NAMESPACE> get events --sort-by=.lastTimestamp
```

On an installer host, also include the output of `orchardctl status`. To report a problem, open an issue in the [Orchard repository](https://github.com/hackclub/orchard/issues).
