---
title: Manage nodes and pools
description: Group Orchard cluster nodes into pools, assign nodes to organizations, and resolve pods that do not schedule.
sidebar:
  order: 3
---

To control where workloads run on a multi-node cluster, create node pools and assign nodes to organizations. You must be a superadmin. Pools use Kubernetes node selectors, affinity, and tolerations, so `kubectl describe node` and `kubectl get events` explain placement.

## Sync nodes

1. Go to **Instance admin** > **Nodes**.
2. Select **Sync from cluster**.

## Create a node pool

1. Go to **Instance admin** > **Nodes**.
2. Select **New pool**.
3. Enter a **Name** and **Description**.
4. Add node selectors that match the nodes in the pool.
5. In **Affinity**, select **preferred (soft)** or **required (hard)**.
6. Add tolerations for any taints on the nodes.
7. To let people choose this pool, turn on **User-selectable**.
8. Select **Create pool**.

To let people select a pool, turn on **Let users pick a node pool** in **Userspace scheduling**.

## Assign a node to an organization

1. Go to **Instance admin** > **Nodes**.
2. Select the node.
3. In **Organization assignments**, select the **Organization**.
4. In **Mode**, select `allow` or `deny`.
5. (Optional) Enter **Max services**, **CPU limit**, and **Memory limit**.
6. Select **Save assignment**.

An organization with at least one `allow` assignment runs only on its allowed nodes. An organization never runs on a node with a `deny` assignment.

## Set taints and labels

1. Go to **Instance admin** > **Nodes**.
2. Select the node.
3. Change the taints and select **Save taints**, or change the labels.

A taint repels any workload that does not tolerate it.

## Resolve a pod that does not schedule

Orchard shows the scheduling reason on the app. The usual causes are:

- **Not enough resources:** No node has enough allocatable CPU or memory for the request. Allocatable capacity is smaller than the node's total, because the system reserves a share.
- **A taint with no matching toleration:** Add a toleration to the pool, or remove the taint.
- **A single-writer volume:** The volume is attached to another node, so the pod cannot start on a different one.

On a small cluster, memory requests are the usual limit, even when actual usage is low. A rolling update starts the new pod before it stops the old one, so the node needs room for both.

## Control where builds run

Builds schedule like other workloads, and also need memory on a node. A build that cannot schedule fails with the following error:

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

- [Manage node pools](/operate/node-pools/)
- [Set quotas](/teams/quotas/)
- [Scale an app and set resources](/deploy/scaling/)
- [Troubleshooting Orchard](/operate/troubleshooting/)
