---
title: Tenancy and isolation
description: See what Orchard isolates between organizations and projects, what you must configure for those guarantees to hold, and what Orchard does not guarantee.
sidebar:
  order: 7
---

Orchard treats every organization and every project as mutually untrusted. This page states what is isolated, what enforces it, and what you must configure. For the network and kernel details, refer to [Security and isolation](/operate/security/).

Some items below are marked planned. They do not exist yet.

## What is isolated

| Boundary                                                | Enforced by                                                                                                                                                                      | What you must configure                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Organization from organization in the dashboard and API | Membership checks on every route. A user outside an organization gets a not-found response, not a permission error.                                                              | Nothing. Limit who is a superadmin, because superadmins can read every organization.                 |
| Project from project inside an organization             | Project roles (admin, member, viewer), project-scoped API tokens, and scoped MCP grants. Org owners and admins see every project.                                                | Give people project roles, not org admin.                                                            |
| Network between tenants                                 | A `default-deny-all` NetworkPolicy in every tenant namespace that Orchard restores if it is removed or edited.                                                                   | A CNI that enforces NetworkPolicy, such as Cilium or Calico. Orchard does not check that yours does. |
| Kernel between tenants                                  | A sandbox RuntimeClass on tenant pods.                                                                                                                                           | `tenantSandbox` with gVisor, and `builderSandbox` with Kata. Both are off by default.                |
| Builds                                                  | One BuildKit daemon per project namespace, a separate pusher container that holds the registry login, and an admission rule that stops a pod from using another project's image. | `builderSandbox`, and `REGISTRY_IMAGE_POLICY=enforce`.                                               |
| Secrets                                                 | Encrypted at rest, write-only in the API, and mounted only in the project's namespace.                                                                                           | `SECRETS_ENCRYPTION_KEY`.                                                                            |
| Database backups                                        | The backup proxy gives each database a key that works only for its own bucket prefix.                                                                                            | `r2Proxy.allowedBuckets` listing only the buckets you intend.                                        |
| Single sign-on and SCIM                                 | Sessions from one organization's identity provider see only that organization. Email-domain routing uses only domains the organization verified.                                 | Verify the organization's domains before you enforce SSO.                                            |
| Quotas                                                  | A ResourceQuota and LimitRange in each namespace.                                                                                                                                | Set organization CPU and memory caps. Without caps the namespace has no CPU or memory quota.         |

## Hardened profile checklist

A single chart profile that sets these is planned, along with an `orchard doctor` command that checks a live cluster. Until then, set each item yourself.

- [ ] Install gVisor on every node and set `tenantSandbox.enabled: true`. Confirm with `kubectl get runtimeclass gvisor`.
- [ ] Install Kata and set `builderSandbox.enabled: true`. Without it, builds run privileged on the host kernel.
- [ ] Use a CNI that enforces NetworkPolicy. Test it: from a pod in one tenant namespace, try to reach a pod in another.
- [ ] If you use Cilium, add policies that deny egress from tenant namespaces to the `host`, `remote-node` and `kube-apiserver` entities. Orchard does not ship these. The `10.0.0.0/8` style exceptions in the tenant policy do not cover node or apiserver addresses that are public.
- [ ] Restrict DNS queries from tenant pods to names in their own namespace (a Cilium DNS rule). Planned as part of the profile. Without it a tenant can list the service names of other namespaces.
- [ ] Leave Pod Security Admission at `baseline` enforce, which Orchard sets on tenant namespaces. Do not remove the labels.
- [ ] Set `REGISTRY_IMAGE_POLICY=enforce`. The code default is `warn`.
- [ ] Set `SECRETS_ENCRYPTION_KEY`, and enable encryption of Secrets at rest in Kubernetes.
- [ ] Set `TRUST_PROXY` (`clientIp.trustProxy`) to the number of proxies in front of the server, and restrict the origin so that only your CDN or tunnel can reach it. Orchard does not lock the origin for you.
- [ ] Put the tenant app domain on a different registrable domain from the dashboard, and add it to the [Public Suffix List](https://publicsuffix.org/). Without that, apps on sibling hostnames can set cookies for each other. Never set `COOKIE_DOMAIN` to a parent of the app domain.
- [ ] Turn on custom-domain verification (`CUSTOM_DOMAIN_VERIFICATION=true`). It is off by default, so the first project to claim a hostname wins.
- [ ] Set `publicTls.db.mode: perDatabase` if you offer public databases. In the default `wildcard` mode, the wildcard private key is copied into each tenant namespace that has a public database, and anyone who can open a shell in that database pod can read it. `perDatabase` counts against Let's Encrypt rate limits.
- [ ] Give the build cache its own bucket and its own access key (`BUILDKIT_S3_ACCESS_KEY_ID`). The default key is bucket-wide.
- [ ] Do not share administrator credentials. The registry login that builds use is shared by all tenants today, so use a dedicated low-privilege account, not the Harbor `admin` account. Per-organization registry accounts are planned.
- [ ] Use a wildcard certificate for generated app hostnames, so that project hostnames do not appear one by one in Certificate Transparency logs. Refer to [Set up wildcard certificates](/operate/wildcard-certificates/).
- [ ] Keep the VictoriaMetrics and VictoriaLogs services unreachable from outside the cluster. They have no authentication.

## What Orchard does not guarantee

- **Kernel isolation by default.** Without gVisor or Kata, tenant pods share the host kernel. A container escape reaches every tenant on the node.
- **Isolation without a NetworkPolicy-enforcing CNI.** Orchard creates the policy and cannot tell whether it is enforced.
- **Instant policy at creation.** If creating a namespace's network policy fails, the project is still created, and the policy is restored later by the guard or at the next server start. Check the logs for `Failed to create network policy`.
- **Protection from the control plane itself.** The server's service account can create pods in any namespace, bind a role that reads Secrets in any namespace, and delete the isolation policies. A compromise of the server is a compromise of the cluster. A least-privilege redesign is planned.
- **Database sandboxing.** Managed database pods do not use the tenant RuntimeClass.
- **Secrecy from project editors.** Anyone with edit access to a project can open a shell in its pods, including database pods, and read their environment.
- **Hiding names from cluster operators.** Namespace names contain the organization and project slugs, and an organization transfer keeps the old name.
- **Hardware isolation.** gVisor and Kata reduce the attack surface of the kernel. Neither is a separate machine.

## What a tenant can learn about other tenants

With the checklist above in place, tenant pods cannot reach the Kubernetes API, the metrics and log stores or other tenants' unpublished services. These remain:

- Public hostnames of anything with its own certificate, through Certificate Transparency logs.
- The service names of other namespaces, through cluster DNS, until you add a DNS rule.
- Services another tenant has published, which answer on the pod network as they do on the internet.
- On the login endpoints, the name, slug and sign-in providers of an organization that has SSO turned on, if someone guesses its slug. An organization without SSO is indistinguishable from a missing one.

The full inventory is in the internal tenancy model, `docs/tenancy-model.md` in the repository.

## Related resources

- [Security and isolation](/operate/security/)
- [Go to production](/operate/production/)
- [Set up wildcard certificates](/operate/wildcard-certificates/)
- [Set quotas](/teams/quotas/)
