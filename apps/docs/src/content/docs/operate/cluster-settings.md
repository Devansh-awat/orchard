---
title: Cluster settings to review
description: The Helm values and cluster steps that harden an Orchard install, with how to check each is safe, how to set it, and how to undo it.
sidebar:
  order: 8
---

Orchard hardens tenants by default. A few protections depend on your cluster, so they are off or advisory until you set them. Each entry says what to check first, how to set it, and how to undo it. Run `orchard doctor` first: it flags the ones that apply to your install. See [Doctor](/operate/doctor/).

## Block tenant NodePorts

Value: `tenant.nodePortExposure: false`.

A NodePort opens a port on every node. On a shared cluster that is a port on machines other tenants' pods run on. With this set, tenants get raw TCP ports through your public IP (`tenant.publicIp`) instead.

- **Check first.** `kubectl get svc -A | grep NodePort`. Services that already exist keep working, and so do redeploys of them. Only creating a new NodePort, or switching a port from internal to public, is refused.
- **Also do.** Firewall the node port range (30000-32767) and the kubelet, SSH and API ports at your cloud or host. Orchard cannot do that for you.
- **Undo.** Set it back to `true`.

## Check issuers and storage classes

Values: `admissionPolicies.extraIssuers`, `admissionPolicies.storageClasses`.

The admission guard can check which certificate issuer a tenant Ingress names and which StorageClass a tenant PVC names. The issuer rule always allows `tenant.certClusterIssuer`. Add any other issuer you hand out, such as a DNS-01 wildcard issuer, to `extraIssuers`. Set `storageClasses` to the classes tenants may use, for example `[longhorn]`. An empty list skips that rule.

- **Check first.** `kubectl get ingress -A -o jsonpath='{range .items[*]}{.metadata.annotations.cert-manager\.io/cluster-issuer}{"\n"}{end}' | sort | uniq -c` and `kubectl get pvc -A -o custom-columns=SC:.spec.storageClassName | sort | uniq -c` list what is in use. Every value in those lists must appear in your setting.
- **Mode.** The guard refuses by default, so a missing issuer or class refuses that tenant's Ingress or PVC. To try a value without that risk, set `admissionPolicies.validationActions: [Warn, Audit]` first, read the warnings, then set it back to `[Deny]`.
- **Undo.** Empty the list.

## Move the hardening rules to Deny

Value: `admissionPolicies.hardeningActions: [Deny]`.

The rest of the guard refuses by default (`admissionPolicies.validationActions: [Deny]`). The hardening rules (drop ALL capabilities, tenant RuntimeClass) only warn, because pods created before them can fail and a refusal would stop them restarting.

- **Check first.** Look for hardening warnings (events on the namespace, API server audit log). Redeploy the apps that report one.
- **Known warning.** The Tailscale proxy pod that Orchard does not build itself may fail the "drop ALL capabilities" rule.
- **Safe by design.** Every policy has `failurePolicy: Ignore` and every binding tolerates a missing parameter, so a fault in the guard cannot block the cluster. cert-manager's solver objects and the Orchard server are exempt from the object rules.
- **Undo.** Set it back to `[Warn, Audit]`. The change applies in seconds. The same goes for `validationActions` if the guard ever refuses something it should not.

## Sandbox databases and disable the superuser login

Value: `databases.runtimeClassName` (for example `gvisor`), plus `apps/server/scripts/cnpg-disable-superuser.sh`.

Tenant databases are reachable only over the Postgres protocol: there is no shell in the pod, `exec` is refused, the network policy isolates them, and new clusters are created with the `postgres` superuser login off. Without a runtime class, database pods run on the node's kernel, so a Postgres or extension vulnerability would reach the host. gVisor closes that, at a cost in IO and latency.

- **Check first.** The runtime must exist on every node (`kubectl get runtimeclass`). Test with a database you can afford to lose. The setting affects only pods created afterwards, so roll each cluster yourself: switch over, then delete the old primary.
- **Failure policy.** `databases.runtimeClassFailurePolicy: Ignore` (default) never blocks pod creation. `Fail` guarantees that no unsandboxed database pod is admitted, and blocks creation if the policy is broken.
- **Superuser login.** Clusters created before the change still have it. Run the script as a dry run, which lists them, then without the flag. It patches clusters one at a time and stops if any instance pod restarts.
- **Undo.** Clear the value. Existing pods stay sandboxed until recreated.

## Sandbox tenant pods and builds

Values: `tenantSandbox.enabled` (gVisor), `builderSandbox.enabled` (Kata).

These are the strongest isolation Orchard offers and they depend on your nodes. Install the runtime on every node first. A tenant pod that names a missing runtime does not schedule. See [Security and isolation](/operate/security/).

## Per-database certificates

Value: `publicTls.db.mode: perDatabase`.

Gives each public database its own certificate so the shared wildcard key never reaches a tenant. It needs a DNS-01 issuer and every certificate counts against your CA's rate limits (Let's Encrypt allows 50 per registered domain per week). Leave it off on a busy public instance until you have a higher limit.

## Lock the origin to your edge

If a CDN or proxy such as Cloudflare fronts your ingress, allow the ingress controller to accept connections only from the proxy's address ranges. Otherwise anyone who finds the origin address bypasses the proxy's protections. Do this at your cloud firewall or in the controller's allow list, and keep your own monitoring addresses in it. Orchard does not manage it, and getting it wrong takes the site down, so test from outside after changing it.

## Plain-HTTP registry hosts

Setting: `REGISTRY_HTTP_HOSTS`, a comma-separated list of registry hosts Orchard may reach over HTTP, for example an in-cluster service name. An IP address is allowed. Everything in the list is also reserved, so a tenant cannot claim it as a hostname. List only registries on your cluster network.

## Ingress controller

Value: `ingress.enabled`.

The chart's own `IngressRoute` is a Traefik resource for the Orchard dashboard. If you use another controller, set `ingress.enabled: false` and create an Ingress yourself. Tenant ingress follows `tenant.ingressClass` and is separate.

## Defaults for new organizations

New organizations start with no CPU, memory or count caps. On an instance open to public sign-up, set instance defaults for new organizations in the admin panel, or set a limit on an organization afterwards. See [Resource limits](/operate/resource-limits/).
