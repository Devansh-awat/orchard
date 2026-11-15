---
title: Manage nodes and pools
description: Add and remove cluster nodes, group them into pools, assign nodes to organizations, and resolve Orchard pods that do not schedule.
sidebar:
  order: 3
---

Orchard runs on the nodes of your Kubernetes cluster. It does not create or join nodes itself: your Kubernetes distribution does that, and Orchard picks up the change. Once the nodes exist, you control where workloads run with node pools and organization assignments. You must be a superadmin.

Pools use Kubernetes node selectors, affinity, and tolerations, so `kubectl describe node` and `kubectl get events` explain every placement decision.

## Add and remove nodes

### On an installer host

An installer host is single-node. Adding nodes to it is not supported for now, because the node pulls tenant images through a registry mirror at `127.0.0.1` that reaches the bundled zot registry only on the install host. The host setup that Orchard needs, such as the AppArmor profiles, the kernel setting for rootless builds, and `orchardctl harden`, also runs only on that machine. Support for more nodes is planned for a later release.

To run Orchard on more than one machine, use the Helm chart on a multi-node cluster, such as one running [Talos Linux](https://docs.siderolabs.com/talos). Hack Club runs Orchard this way, on six Talos Linux nodes. For the differences, refer to [Choose a layout](/operate/production/#choose-a-layout).

### Add a node to a Helm cluster

1. Join the node with your distribution's tooling. On Talos, refer to [Scale up a Talos cluster](https://docs.siderolabs.com/talos/v1.14/deploy-and-manage-workloads/scaling-up).
2. Prepare the node like the others:
   - Give it credentials for your image registry. Orchard does not add a pull secret to app pods, so a node without credentials cannot run tenant images.
   - If you use `tenantSandbox` or `builderSandbox`, install the same runtimes. A pod that lands on a node without its RuntimeClass handler fails to start.
3. If the node belongs to a [node pool](#create-a-node-pool), give it the labels and taints that the pool selects and tolerates:
   1. Go to **Instance admin** > **Nodes**, and select the node.
   2. In **Labels**, enter the key and value, and select **Add label**.
   3. In **Taints**, select **Add taint**, enter the taint, and select **Save taints**.
4. Confirm that the node appears at **Instance admin** > **Nodes**. Orchard watches the cluster, so a new node appears on its own. If it does not, select **Sync nodes**.

Orchard also adds the addresses of the new node to the egress deny list of every tenant namespace, so tenant pods cannot reach it. For more information, refer to [Network isolation](/operate/security/#network-isolation).

### Remove a node from a Helm cluster

1. Stop new pods from landing on the node:
   1. Go to **Instance admin** > **Nodes**, and select the node.
   2. Select **Cordon**.

   Orchard marks the node unschedulable in Kubernetes, the same as `kubectl cordon <NODE_NAME>`. Pods that already run on the node keep running. To undo this, select **Uncordon**.

2. Move its pods to other nodes:

   ```bash
   kubectl drain <NODE_NAME> --ignore-daemonsets --delete-emptydir-data
   ```

   A pod whose volume exists only on that node, such as a `local-path` volume, cannot start on another node. Move or back up that data before you continue.

3. Remove the node with your distribution's tooling, and then delete it from Kubernetes. On Talos, refer to [Scale down a Talos cluster](https://docs.siderolabs.com/talos/v1.14/deploy-and-manage-workloads/scaling-down).

   ```bash
   kubectl delete node <NODE_NAME>
   ```

When a node leaves the cluster, Orchard keeps its row and its organization assignments for 30 minutes, in case the node registers again. After that, Orchard removes the node from **Instance admin** > **Nodes**, together with its organization assignments.

- **Node pools do not change**, because a pool selects nodes by label, not by name.
- **Organization assignments go away.** If the node held the only `allow` assignment of an organization, that organization can then run on any node. Review its assignments before you remove the node.

## Sync nodes

Orchard keeps the node list current on its own. To force a refresh:

1. Go to **Instance admin** > **Nodes**.
2. Select **Sync nodes**.

The table lists each node with its status, requested CPU and memory, pods, and assignments.

## Create a node pool

A node pool routes workloads to specific nodes.

1. Go to **Instance admin** > **Nodes**.
2. Select **New pool**.
3. In **Name**, enter a name.
4. (Optional) In **Description**, enter a description.
5. In **Affinity**, select **Preferred (soft)** or **Required (hard)**.
6. (Optional) Turn on **User-selectable** to let users select this pool.
7. In **Node selector**, select **Add selector**.
8. Enter the label keys and values of the nodes.
9. In **Tolerations**, select **Add toleration**.
10. Enter a toleration for each taint on the nodes.
11. Select **Create pool**.

To change a pool later, select the edit icon on the pool. To remove a pool, select the delete icon.

## Let users select a pool

Users cannot select a node pool by default. To allow this:

1. Go to **Instance admin** > **Nodes**.
2. In **Userspace scheduling**, turn on **Let users pick a node pool**.
3. Turn on **User-selectable** on each pool that users can select.

The `USERSPACE_NODE_SCHEDULING` environment variable overrides this setting.

To select a pool for an app:

1. Open the app.
2. Go to **Settings** > **Resources**.
3. In **Placement**, select a **Node pool**.

The change applies on the next deploy. Superadmins can select any pool, whether or not it is user-selectable.

## Assign a node to an organization

A node with no assignments accepts workloads from any organization.

1. Go to **Instance admin** > **Nodes**.
2. Select the node.
3. In **Organization assignments**, select **Add**.
4. In **Organization**, select the organization.
5. In **Mode**, select **Allow** or **Deny**.
6. (Optional) Set **CPU limit** (for example, `2` or `500m`), **Memory limit** (for example, `4Gi`), and **Max services**.
7. Select **Save assignment**.

An organization with at least one `allow` assignment runs only on its allowed nodes. An organization never runs on a node with a `deny` assignment.

## Set taints on a node

A tainted node repels workloads that do not tolerate the taint. Create a node pool that tolerates the taint to route specific workloads to the node.

1. Go to **Instance admin** > **Nodes**.
2. Select the node.
3. Select **Add taint**.
4. Enter the key and value.
5. Select the effect: `NoSchedule`, `PreferNoSchedule`, or `NoExecute`.
6. Select **Save taints**.

Orchard writes the taint to the node in Kubernetes.

## Resolve a pod that does not schedule

Orchard shows the scheduling reason on the app. The usual causes are:

- **Not enough resources:** No node has enough allocatable CPU or memory for the request. Allocatable capacity is smaller than the node's total, because the system reserves a share.
- **A taint with no matching toleration:** Add a toleration to the pool, or remove the taint.
- **A single-writer volume:** The volume is attached to another node, so the pod cannot start on a different one.

On a small cluster, memory requests are the usual limit, even when actual usage is low. A [rolling update](/deploy/update-strategies/) starts the new pod before it stops the old one, so the node needs room for both.

## Control where builds run

[Builds](/deploy/builds/) schedule like other workloads, and also need memory on a node. A build that cannot schedule fails with the following error:

```txt
Build failed: could not schedule build pod after 300s - 0/1 nodes are available: 1 Insufficient memory.
```

To reserve a node for builds on a multi-node cluster, label it and set `builders.dedicatedNode.enabled` to `true` in the chart:

```bash
kubectl label node <NODE_NAME> orchard-builder=true
kubectl taint node <NODE_NAME> orchard-builder=true:NoSchedule
```

The taint is optional. To limit how many builds run at once, set `MAX_CONCURRENT_BUILDS` on the server.

On a cluster with both amd64 and arm64 nodes, set `builders.platform` to `linux/amd64` or `linux/arm64`. Builds then run on nodes of that architecture, and apps that Orchard builds are placed on them too.

## Related resources

- [Go to production](/operate/production/) - Choose between the installer and a multi-node Helm cluster.
- [Security and isolation](/operate/security/) - Review how Orchard keeps tenants away from nodes and from each other.
- [Set quotas](/teams/quotas/) - Cap the CPU and memory that each organization can use.
- [Scale an app and set resources](/deploy/scaling/) - Set the requests that decide where an app fits.
