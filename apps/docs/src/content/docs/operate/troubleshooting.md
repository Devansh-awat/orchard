---
title: Troubleshooting Orchard
description: Fix common Orchard failures with builds, apps, databases, domains, sign-in, and the control plane, listed by symptom.
sidebar:
  order: 5
---

Use this page to fix common failures on an Orchard instance. Each entry lists the symptom, the cause, and the fix.

## Builds

### Image builds need a container registry

```txt
Image builds need a container registry, but DOCKER_REGISTRY_PUSH and DOCKER_REGISTRY_PULL are not set
```

**Cause:** The instance has no registry configured. This occurs on a Helm install without registry values.

**Fix:** Set `DOCKER_REGISTRY_PUSH` and `DOCKER_REGISTRY_PULL` on the server. For more information, refer to [Use your own registry](/operate/finishing-setup/#use-your-own-registry).

### A build succeeds and then the push fails

```txt
dial tcp 203.0.113.10:443: connect: connection refused
```

**Cause:** A network policy blocks the builder from reaching the registry. Builders can only reach DNS, public IP addresses on ports 80 and 443, and the destinations in `builders.registryEgress`.

**Fix:** Add the registry to `builders.registryEgress`. For more information, refer to [Use your own registry](/operate/finishing-setup/#use-your-own-registry).

### `orchard up` fails at `context-fetch` with `Connection refused`

```txt
wget: can't connect to remote host (203.0.113.10): Connection refused
```

**Cause:** Your S3 storage runs on the same server or cluster, behind its own ingress. A build fetches its files from that address, and a hostname that resolves to a node loops back to the ingress controller, which a network policy blocks. Backups still work because they don't run in the builder.

**Fix:** [Re-run the installer](/start/install/#run-the-installer-again), which allows Traefik on a current version. With Helm, add the ingress controller's pods to `builders.registryEgress`. Don't add the storage pods themselves, because a build should only reach storage the way the internet does.

### Build fails with a missing module or command

**Cause:** The build targets the wrong stage. A multi-stage Dockerfile built at its first stage produces an image without the application.

**Fix:** Set the [build stage](/deploy/builds/#the-image-has-no-application-in-it) to the final stage.

### Build fails in a layer with an I/O error

**Cause:** The builder has cache or disk pressure.

**Fix:** Check free disk on the build node and the size of the build cache volume.

### A push fails quickly with an error that looks like a rate limit

**Cause:** The BuildKit daemon stopped, and the pusher reports the result.

**Fix:** Read the logs of the `buildkit` container instead of the pusher:

```bash
kubectl -n orchard-builders logs job/<BUILD_JOB_NAME> -c buildkit --tail=30
```

### Could not schedule build pod

```txt
Build failed: could not schedule build pod after 300s - 0/1 nodes are available: 1 Insufficient memory.
```

**Cause:** No node has enough unreserved memory. The scheduler uses memory requests, not actual usage.

**Fix:** Reduce the memory that apps and databases request, or add a node. For more information, refer to [Manage nodes and pools](/operate/nodes/).

## Apps

### CrashLoopBackOff

**Cause:** The app exits soon after it starts.

**Fix:** Read the [crash report](/run/logs/#read-crash-output) on the app. It includes the logs of the container that stopped.

### Exit code 137

**Cause:** The container ran out of memory.

**Fix:** Raise the [memory limit](/deploy/scaling/#set-cpu-and-memory) of the app, or fix the leak.

### The app is live but its URL returns `502 Bad Gateway`

**Cause:** The pod runs, but nothing listens on the port Orchard routes to. Without a health check, a running container counts as ready. `orchard up` and other commands that wait for a deploy warn you with `Nothing is listening on port`.

**Fix:** Go to the app's **Network** tab and set the port your process listens on. To catch this in a rollout, add a health check. For more information, refer to [Scaling](/deploy/scaling/).

### Running but never ready

**Cause:** The health check uses the wrong path or port, or the app starts more slowly than the check allows.

**Fix:** Correct the [health check](/deploy/scaling/#set-health-checks), or give it a longer start time.

### One app cannot reach another

**Cause:** The request uses the public URL.

**Fix:** Use the [internal cluster address](/deploy/networking/#connect-apps-inside-the-cluster) shown under the port.

## Databases

### Instance Status Extraction Error

**Cause:** The tenant network policy blocks the CloudNativePG operator from reaching database pods. The server allows the namespace in `CNPG_OPERATOR_NAMESPACE`, which defaults to `postgresql`.

**Fix:** Set `CNPG_OPERATOR_NAMESPACE` in `server.env` to the namespace where the operator runs, such as `cnpg-system`. The installer sets this for you.

### No backup storage

```txt
No backup storage. Set it up for this organization, or set a backup bucket on the instance.
```

**Cause:** The instance has no backup bucket. This occurs on a Helm install without object storage.

**Fix:** Refer to [Configure database backups](/operate/finishing-setup/#configure-database-backups).

### An application cannot connect

**Cause:** The connection uses the wrong host or endpoint.

**Fix:** Use the internal host and the [`-rw` endpoint](/data/replicas/#endpoints). The `-ro` endpoint only accepts reads.

### Reads return old data

**Cause:** [Replicas are asynchronous](/data/replicas/#replication-lag).

**Fix:** Send reads that must see the latest writes to `-rw`.

### A restore produces an empty database

**Cause:** No base backup exists. Archived write-ahead logs alone cannot restore a database.

**Fix:** Check how far back the database can be restored:

```bash
orchard db recovery <DATABASE_ID>
```

### A database restarts every few minutes

**Cause:** The container is out of memory. If the restarts line up with the backup window, the base backup uses memory from the same container.

**Fix:** Read the last termination reason. Raise the [memory of the database](/data/databases/#set-cpu-and-memory). Do not set [`shared_buffers`](/data/parameters/#shared-buffers) close to the memory limit. If you leave `shared_buffers` empty, Orchard sizes it.

### The database page shows one replica and no pods

**Cause:** The instance is not running. If the page lists the storage volume as dangling, Kubernetes does not recreate the pod.

**Fix:** An operator must inspect the cluster:

```bash
kubectl -n <NAMESPACE> get pods,pvc
```

## Domains

### A certificate never issues

**Cause:** One of the following:

- DNS does not resolve to the instance yet. Check [Point DNS at this instance](/operate/finishing-setup/#point-dns-at-this-instance).
- The ingress controller cannot reach the ACME solver. Check [Let the ingress controller reach apps](/operate/finishing-setup/#let-the-ingress-controller-reach-apps).

**Fix:** Correct the cause, then check the challenge:

```bash
kubectl get challenges -A
```

### A webhook receives a sign-in page

**Cause:** The app is protected and the webhook path is not a public path.

**Fix:** Add the path to the public paths list. For more information, refer to [Protect an app](/deploy/protection/).

## Sign-in

### No option to sign in with an email code

**Cause:** The instance has no email configured, so Orchard hides email codes.

**Fix:** On the host, run [`sudo orchardctl login`](/operate/host-commands/#login) or [`sudo orchardctl password set`](/operate/host-commands/#password). To add email, refer to [Set up email](/operate/finishing-setup/#set-up-email).

On a Helm install, print a one-time sign-in link with the following command. To sign in as someone other than the first superadmin, add `--email <ADDRESS>`.

```bash
kubectl -n orchard exec deploy/server -- node dist/scripts/mint-login-link.js
```

## Control plane

### The installer stops on an IPv6-only server

```txt
IPv6-only servers are not supported yet. This server has no IPv4 address.
```

**Cause:** The server has no IPv4 address. GitHub and `ghcr.io` have no IPv6 addresses, so the server cannot download k3s or the Orchard images, and Orchard cannot clone or build from GitHub. k3s runs with IPv4 inside the cluster, and Orchard listens on IPv4 only, so traffic to the IPv6 address does not reach it.

**Fix:** Use a server with an IPv4 address. A server with both IPv4 and IPv6 addresses works.

To try anyway, add `--allow-ipv6-only` when you run the installer. `--yes` does not imply this flag. NAT64 in front of an IPv4 server is unsupported, and Orchard has not tested it.

### The installer stops partway

**Cause:** A step failed. The installer prints the step and the error.

**Fix:** Correct the problem, then [run the installer again](/start/install/#run-the-installer-again). It reads your current settings and continues from them. Do not delete `/etc/orchard/values.yaml` to get past a failure, because a new file means new secrets, and Orchard cannot read data encrypted with the old ones.

### A tunnel install fails with a handshake error

```txt
curl: (35) sslv3 alert handshake failure
```

**Cause:** The name is more than one level under your Cloudflare zone, such as `orchard.dev.example.com`. Cloudflare's free certificate covers `example.com` and `*.example.com` only, so the connection fails at Cloudflare. The tunnel is healthy, and plain HTTP still works.

**Fix:** Use names directly under the zone, or add Advanced Certificate Manager in Cloudflare. To change a name, re-run the installer.

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

**Cause:** The cluster rejects the write, and the [apply queue](/operate/architecture/#writes) retries it.

**Fix:** Read the events in the tenant namespace:

```bash
kubectl -n <TENANT_NAMESPACE> get events --sort-by=.lastTimestamp
```

### An upgrade says a Certificate cannot be imported

```txt
Error: UPGRADE FAILED: Unable to continue with update: Certificate "orchard-tls" in namespace "orchard" exists and cannot be imported into the current release: invalid ownership metadata
```

**Cause:** You created the object by hand, and the chart now manages it.

**Fix:** Give the object to Helm, then run the upgrade again. This keeps the certificate that is already issued.

```bash
kubectl -n orchard label certificate orchard-tls app.kubernetes.io/managed-by=Helm
kubectl -n orchard annotate certificate orchard-tls \
  meta.helm.sh/release-name=orchard \
  meta.helm.sh/release-namespace=orchard
```

### An upgrade says another operation is in progress

```txt
Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress
```

**Cause:** An earlier Helm operation was interrupted, and the release is stuck in a pending state.

**Fix:** Find the last revision with the status `deployed`, and roll back to it. Then upgrade again.

```bash
sudo helm -n orchard history orchard
sudo helm -n orchard rollback orchard <REVISION>
sudo orchardctl update
```

If the stuck revision is the first install, there is nothing to roll back to. Uninstall the release, and install it again.

## Still stuck?

Collect the following before you ask for help:

```bash
kubectl -n orchard logs deploy/server --tail=200
kubectl -n <TENANT_NAMESPACE> get events --sort-by=.lastTimestamp
```

On an installer host, also include the output of `orchardctl status`. To report a problem, open an issue in the [Orchard repository](https://github.com/hackclub/orchard/issues).

## Related resources

- [Finish instance setup](/operate/finishing-setup/)
- [Builds](/deploy/builds/)
- [Host commands](/operate/host-commands/)
- [Troubleshooting Greenhouse](/greenhouse/troubleshooting/)
- [Troubleshooting grafts](/grafts/troubleshooting/)
