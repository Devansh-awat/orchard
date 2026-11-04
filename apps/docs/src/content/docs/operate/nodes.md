---
title: Manage nodes and pools
description: Group Orchard cluster nodes into pools, assign nodes to organizations, and resolve pods that do not schedule.
sidebar:
  order: 3
---

To control where workloads run on a multi-node cluster, create node pools and assign nodes to organizations. You must be a superadmin. Pools use Kubernetes node selectors, affinity, and tolerations, so `kubectl describe node` and `kubectl get events` explain placement.

## Sync nodes

1. Go to **Instance admin** > **Nodes**.
2. Select **Sync nodes**.

The table lists each node with its usage and assignments.

## Create a node pool

A node pool routes workloads to specific nodes.

1. Go to **Instance admin** > **Nodes**.
2. In the node pools section, select **New pool**.
3. In **Name**, enter a name.
4. (Optional) In **Description**, enter a description.
5. In **Affinity**, select **preferred (soft)** or **required (hard)**.
6. (Optional) Turn on **User-selectable** to let users select this pool.
7. In **Node selector**, select **Add**.
8. Enter the label keys and values of the nodes.
9. In **Tolerations**, select **Add**.
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
3. In **Organization assignments**, select an **Organization**.
4. In **Mode**, select `allow` or `deny`.
5. (Optional) Set **Max services**, **CPU limit, for example 2 or 500m**, and **Memory limit, for example 4Gi**.
6. Select **Save assignment**.

An organization with at least one `allow` assignment runs only on its allowed nodes. An organization never runs on a node with a `deny` assignment.

## Set taints on a node

A tainted node repels workloads that do not tolerate the taint. Create a node pool that tolerates the taint to route specific workloads to the node.

1. Go to **Instance admin** > **Nodes**.
2. Select the node.
3. Select **Add taint**.
4. Enter the key and value.
5. Select the effect: `NoSchedule`, `PreferNoSchedule`, or `NoExecute`.
6. Select **Save taints**.

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

To reserve a node for builds, label it and set `builders.dedicatedNode.enabled` to `true` in the chart:

```bash
kubectl label node <NODE_NAME> orchard-builder=true
kubectl taint node <NODE_NAME> orchard-builder=true:NoSchedule
```

The taint is optional. To limit how many builds run at once, set `MAX_CONCURRENT_BUILDS` on the server.

## Related resources

- [Instance admin](/operate/instance-admin/)
- [Security and isolation](/operate/security/)
- [Set quotas](/teams/quotas/)
- [Scale an app and set resources](/deploy/scaling/)
- [Troubleshooting Orchard](/operate/troubleshooting/)
