---
title: Compatibility
description: Check which Kubernetes versions, distributions, CNIs, ingress controllers, storage classes, registries, and CPU architectures Orchard supports, and which features depend on each.
---

Orchard runs on a Kubernetes cluster that you own, so most of what it can do depends on the components in that cluster. This page lists what is tested, what is expected to work, and which Orchard features need a specific component, so that you can plan a cluster before you install.

Each table uses three levels of support:

- **Tested**: run in continuous integration (CI) or in production by Hack Club.
- **Expected to work, not tested**: meets the requirements on this page, but nobody has run Orchard on it end to end.
- **Not supported**: Orchard does not work, or a guarantee does not hold.

## Kubernetes versions and distributions

Orchard needs Kubernetes 1.30 or later. The chart installs `ValidatingAdmissionPolicy` objects (`admissionregistration.k8s.io/v1`) that guard tenant namespaces, and that API is generally available from Kubernetes 1.30. For what the policies enforce, refer to [Admission guard for tenant namespaces](/operate/security/#admission-guard-for-tenant-namespaces).

| Setup                                                                                          | Support                      | Details                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-command installer                                                                          | Tested                       | Creates a single-node [k3s](https://k3s.io/) cluster. CI tests it on Ubuntu 24.04 (amd64 and arm64) and Ubuntu 26.04 (amd64). It needs a Linux distribution with systemd. Other systemd distributions can work, but they are not tested. |
| Helm chart on k3s                                                                              | Tested                       | Run end to end on one node with k3s v1.36.5 and its bundled Traefik. For what that run covered, refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).                                               |
| Helm chart on Talos Linux                                                                      | Tested                       | Hack Club runs its production instance on a six-node [Talos Linux](https://docs.siderolabs.com/talos) cluster with Cilium.                                                                                                               |
| Helm chart on other distributions, such as kubeadm, RKE2, Amazon EKS, Google GKE, or Azure AKS | Expected to work, not tested | Any distribution is expected to work if it meets the requirements on this page, but these distributions are not tested.                                                                                                                  |

Adding nodes to an installer host is not supported for now. To run on more than one machine, use the Helm chart. For the differences, refer to [Choose a layout](/operate/production/#choose-a-layout).

## Supported CNIs

Every network boundary between tenants is a Kubernetes NetworkPolicy. The API server only stores a NetworkPolicy, and the Container Network Interface (CNI) plugin enforces it. Orchard supports any CNI that enforces Kubernetes NetworkPolicy. A CNI that does not enforce it leaves every tenant able to reach every other tenant, without any error.

| CNI                                                                    | Support                                        | Details                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cilium                                                                 | Tested, recommended                            | Hack Club runs it in production. With `cilium.enabled: true`, Orchard adds the [Cilium-only controls](#what-differs-without-cilium) below.                                                                                                                                                                                               |
| k3s built-in (Flannel with the embedded kube-router policy controller) | Tested                                         | The installer default. k3s enforces NetworkPolicy unless you start it with `--disable-network-policy`.                                                                                                                                                                                                                                   |
| Calico                                                                 | Expected to work, not tested                   | Enforces NetworkPolicy.                                                                                                                                                                                                                                                                                                                  |
| Antrea                                                                 | Expected to work, not tested                   | Enforces NetworkPolicy.                                                                                                                                                                                                                                                                                                                  |
| Canal (Flannel with Calico policy)                                     | Expected to work, not tested                   | Enforces NetworkPolicy.                                                                                                                                                                                                                                                                                                                  |
| kube-router                                                            | Expected to work, not tested                   | Enforces NetworkPolicy, as the full CNI or in policy-only mode next to another CNI.                                                                                                                                                                                                                                                      |
| GKE Dataplane V2                                                       | Expected to work, not tested                   | Enforces NetworkPolicy.                                                                                                                                                                                                                                                                                                                  |
| Amazon VPC CNI                                                         | Expected to work, not tested                   | Only with network policy turned on in the VPC CNI.                                                                                                                                                                                                                                                                                       |
| Azure CNI on AKS                                                       | Expected to work, not tested                   | Only with a network policy engine: Azure Network Policy Manager or Cilium.                                                                                                                                                                                                                                                               |
| Flannel alone                                                          | Expected to work with the enforcer, not tested | Flannel does not enforce NetworkPolicy. Set `networkPolicy.enforcer.enabled: true`, which runs kube-router in policy-only mode next to Flannel. For the steps, refer to [Enforce network policies on Flannel](/operate/tenancy-and-isolation/#enforce-network-policies-on-flannel). Talos deploys Flannel unless you choose another CNI. |
| Other CNIs that do not enforce NetworkPolicy                           | Not supported                                  | Tenant isolation does not hold. The chart's enforcer is documented for Flannel only.                                                                                                                                                                                                                                                     |

### What differs without Cilium

Orchard writes the same NetworkPolicy objects on every CNI. Cilium adds controls that the standard NetworkPolicy API cannot express. The server turns them on when it can create Cilium objects: set `cilium.enabled: true` in the chart, which grants the server the `cilium.io` permissions and sets `CILIUM_ENABLED=true`. Without that value, the server checks for the `cilium.io` API and for permission to create `CiliumEnvoyConfig` objects, and uses plain NetworkPolicy when either is missing.

| Control                                                   | With Cilium                                                                                                                                          | Without Cilium                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant traffic to nodes and the Kubernetes API server     | A `CiliumNetworkPolicy` in each tenant namespace denies egress to the `host`, `remote-node`, and `kube-apiserver` entities (`TENANT_DENY_ENTITIES`). | An `ipBlock` exception list built from node addresses, pod CIDRs, and API server addresses. Refer to the explanation after this table. |
| Basic authentication (the **Username and password** type) | Enforced by Envoy through a `CiliumEnvoyConfig` bound to the app's Service.                                                                          | Enforced by the Orchard protection proxy. Visitors see the same result.                                                                |
| Database operator access                                  | `CiliumNetworkPolicy` objects in each database namespace allow the CloudNativePG operator and the API server.                                        | A NetworkPolicy lists the API server addresses and the operator namespace.                                                             |

The NetworkPolicy API does not define how a policy applies to traffic to the node itself, or to pods that use the host network. Whether an `ipBlock` rule matches a node address depends on the CNI. Because of this, Orchard approximates the Cilium entity rules without Cilium: it lists every node's internal and external IPv4 addresses, the pod CIDRs, and the API server addresses, and excepts them from the tenant egress rule. When node addresses change, the server rewrites the affected policies. Private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and `169.254.0.0/16`) are always excepted. For public addresses that Orchard cannot find, such as a load balancer, add them to `tenant.extraDenyCidrs`.

As a result, without Cilium, whether a tenant pod can reach a node, the API server, or a host-network pod depends on how your CNI applies `ipBlock` rules, not on a rule that Orchard controls. Run the self-test below to find out, and firewall node management ports at the host or the cloud, as described in [Tenancy and isolation](/operate/tenancy-and-isolation/#what-you-must-do).

### Prove enforcement

A CNI name is not proof that policy is enforced. Run the isolation self-test from the CLI:

```sh
orchard doctor --selftest
```

The self-test creates two temporary tenant namespaces through the server's normal path, starts probe pods, and tries to reach the API server, node management ports (`10250`, `22`, `6443`, and `50000`), the cloud metadata address, platform services, ingress controller debug ports, and a pod in the other tenant namespace. Each attempt must be dropped. The `cni-enforcement` check in later `orchard doctor` reports from the same server then uses this result instead of the CNI name. For how to read the result, refer to [The isolation self-test](/operate/doctor/#the-isolation-self-test).

## Supported ingress controllers

Orchard routes tenant apps with standard Kubernetes `Ingress` objects of the class in `tenant.ingressClass` (`K8S_INGRESS_CLASS`). When the value is empty, the server uses `haproxy`. Orchard does not create controller-specific objects or annotations for tenant apps, so app routing works with any controller that serves `Ingress`. An admission policy allows only that class on tenant Ingresses, and it rejects `haproxy.org/*`, `nginx.ingress.kubernetes.io/*`, and `traefik.*` annotations from tenants.

Most features work the same on every controller. Request metrics, access logs, and the control-plane routes that the chart creates depend on it, and the installer installs and configures Traefik.

| Feature                                                                     | Traefik                        | HAProxy Kubernetes Ingress Controller                                           | Another IngressClass, such as ingress-nginx |
| --------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Support                                                                     | Tested. The installer default. | Tested. Hack Club runs it in production, and the chart falls back to its class. | Expected to work, not tested                |
| App routing on generated and custom domains                                 | Yes                            | Yes                                                                             | Yes                                         |
| TLS from cert-manager, including wildcard certificates                      | Yes                            | Yes                                                                             | Yes                                         |
| Domain redirects                                                            | Yes                            | Yes                                                                             | Yes                                         |
| HTTP to HTTPS redirect                                                      | Controller setting             | Controller setting                                                              | Controller setting                          |
| **Password**, **Username and password**, and **Project members** protection | Yes                            | Yes                                                                             | Yes                                         |
| Public TCP and UDP ports                                                    | Yes                            | Yes                                                                             | Yes                                         |
| WebSockets                                                                  | Controller default             | Controller default                                                              | Controller default                          |
| Client address from `X-Forwarded-For`                                       | Yes                            | Yes                                                                             | Yes, if the controller sets the header      |
| Request, error, and latency charts                                          | Yes                            | Yes                                                                             | No. The charts stay empty.                  |
| Access logs in the dashboard                                                | Yes, with JSON access logs     | Yes, with the JSON log format Orchard reads                                     | No                                          |
| Dashboard and MCP routes from the chart                                     | Yes (`IngressRoute`)           | No. Route them yourself.                                                        | No. Route them yourself.                    |

Notes on the table:

- **TLS.** cert-manager solves HTTP-01 challenges in place on the app's own Ingress, so the solver uses the same class as the app. The `ClusterIssuer` names its own solver class, and the installer's issuer uses `traefik`.
- **Redirects and protection.** Orchard serves domain redirects and the password, sign-in, and basic authentication checks from its protection proxy, behind a normal Ingress backend. With Cilium, Envoy checks basic authentication instead. None of them use controller middleware. Orchard does not add an HTTP to HTTPS redirect for apps, so plain HTTP behaves as your controller is configured.
- **Public ports.** Orchard exposes TCP and UDP ports with `NodePort` or `LoadBalancer` Services, not through the ingress controller. A `LoadBalancer` port needs a layer 4 load balancer in the cluster.
- **Metrics and logs.** The server reads request series from the Traefik and HAProxy scrape jobs only, and the log collector reads only those controllers' pods. `INGRESS_METRICS` forces one adapter. For setup, refer to [Point app metrics at your ingress controller](/operate/finishing-setup/#point-app-metrics-at-your-ingress-controller) and [Access logs](/operate/logs/#access-logs).
- **Control-plane routes.** The chart routes the dashboard (`ingress.enabled`) and the MCP endpoint (`mcp.ingress.enabled`) with Traefik `IngressRoute` objects. On another controller, turn both off and route the hostnames yourself. Refer to [Ingress controller](/operate/production/#ingress-controller).
- **Controller namespace.** Tenant namespaces accept traffic only from the namespaces in `tenant.ingressNamespaces`. Set it to your controller's namespace, or certificates never issue. Refer to [Let the ingress controller reach apps](/operate/finishing-setup/#let-the-ingress-controller-reach-apps).

Orchard does not create Gateway API routes (`HTTPRoute`) for apps. The installer applies the Gateway API CRDs because the Traefik chart's Gateway provider uses them.

## Storage classes and CSI drivers

Orchard works with any Container Storage Interface (CSI) driver behind a StorageClass. Every volume uses the cluster's default StorageClass unless you name one: `tenant.storageClass` (`K8S_STORAGE_CLASS`) for app volumes and databases, and a `storageClass` key for each platform volume. `admissionPolicies.storageClasses` limits which classes a tenant volume can name. For production, Orchard recommends a replicated class. Refer to [Storage class](/operate/production/#storage-class).

| Capability                                      | Orchard uses it for                                                                      | Without it                                                                                                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic provisioning                            | Every app volume, database, and platform volume                                          | Claims stay `Pending`. The dashboard shows the volume as waiting for storage.                                                                                                                                     |
| Volume expansion (`allowVolumeExpansion: true`) | [Growing an app volume](/deploy/storage/) and [growing database storage](/data/storage/) | Kubernetes rejects the resize and the volume keeps its old size. For an app volume, the deployment shows that the change was not applied. Orchard does not check the StorageClass before it accepts the new size. |
| `ReadWriteOnce` access                          | Every volume. Orchard does not use `ReadWriteMany`.                                      | Not applicable.                                                                                                                                                                                                   |
| Attaching a volume on another node              | Rescheduling a pod with a volume after a node fails or drains                            | The pod can only run on the node that holds the volume. `local-path` behaves this way.                                                                                                                            |
| Volume snapshots (`VolumeSnapshotClass`)        | Forking a [Greenhouse](/operate/greenhouse/) sandbox only                                | Greenhouse does not offer forks. Database backups, restores, and clones use object storage and `pg_basebackup`, not snapshots.                                                                                    |
| Raw block volumes (`volumeMode: Block`)         | Build scratch space, only with `builderSandbox.scratch.mode: block`                      | Use the default scratch mode.                                                                                                                                                                                     |
| Kubelet volume statistics                       | Database disk usage charts                                                               | The charts stay empty. The database capacity bar and paused writes measure the disk inside the pod, so they still work.                                                                                           |

Because every volume is `ReadWriteOnce`, a deployment with a volume runs one pod on most classes, and [updates stop the app first](/deploy/update-strategies/). Orchard does not set a volume binding mode or node affinity for volumes, so both `Immediate` and `WaitForFirstConsumer` classes work.

Orchard does not set a reclaim policy. The StorageClass decides what happens to the data when Orchard deletes a volume or a database. The chart keeps the bundled object storage volume, its namespace, and its Secret when you uninstall it (`helm.sh/resource-policy: keep`), and no other volume.

The installer uses the `local-path` class that k3s bundles for every volume. A `local-path` volume is a directory on the node, so it does not survive the loss of the machine, and the provisioner does not support volume expansion.

## Container registries and object storage

| Component        | Support                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zot              | The installer runs zot, bound to loopback on the install host. The Helm chart does not deploy it.                                                                                                              |
| Harbor           | Orchard detects Harbor through its API, deletes old images through it, and can use Harbor's scanner. Refer to [Set up Harbor](/operate/image-scanning/#set-up-harbor).                                         |
| Any OCI registry | Builds push to `DOCKER_REGISTRY_PUSH` and nodes pull from `DOCKER_REGISTRY_PULL`. Each node needs its own pull credentials. Refer to [Use your own registry](/operate/finishing-setup/#use-your-own-registry). |
| Object storage   | Any S3-compatible service, such as Amazon S3 or Cloudflare R2, for database backups and uploads. The installer runs an S3-compatible store inside the cluster. Refer to [Add S3 storage](/operate/storage/).   |

## Architectures and runtimes

| Component                  | Support                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CPU architecture           | amd64 and arm64. The installer refuses other architectures.                                                               |
| gVisor for tenant pods     | Optional. Set `tenantSandbox.enabled: true` on nodes that provide the runtime. The default RuntimeClass name is `gvisor`. |
| Kata Containers for builds | Optional. Set `builderSandbox.enabled: true` on nodes that provide the runtime. The default RuntimeClass name is `kata`.  |

Without a sandbox runtime, tenant pods share the node kernel. For what each runtime protects against and how to turn it on, refer to [Kernel isolation](/operate/security/#kernel-isolation).

## Related resources

- [Go to production](/operate/production/) - Choose a layout and replace bundled components with ones you operate.
- [Tenancy and isolation](/operate/tenancy-and-isolation/) - Review what Orchard isolates and what you must configure for it to hold.
- [Check isolation with orchard doctor](/operate/doctor/) - Run the configuration checks and the isolation self-test.
