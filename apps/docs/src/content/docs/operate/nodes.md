---
title: Nodes and pools
description: Deciding what runs where.
sidebar:
  order: 3
---

On a multi-node cluster, superadmins can group nodes into **pools** and control
what lands on them.

## Pools

A pool is a set of nodes with a purpose: general workloads, builds, a machine
with more memory, hardware someone specific paid for. Pools can be assigned to
organizations, so a tenant's apps schedule onto the nodes intended for them.

## Taints and affinity

Pools work through Kubernetes taints and affinity rather than a parallel
scheduler. A tainted node repels anything that does not tolerate it; affinity
pulls matching workloads towards it. Orchard sets these when it creates workloads
for an organization mapped to a pool.

Because it is ordinary Kubernetes scheduling, `kubectl describe node` and
`kubectl get events` explain placement decisions the same way they always do.

## Builds

Builds are scheduled like other workloads, and benefit from landing on nodes with
the build cache. Concurrency is bounded so builds cannot take a node's memory
away from running apps.

## When a pod will not schedule

Usually one of:

- No node has enough **allocatable** CPU or memory for the request. Allocatable is
  smaller than the node's total, because the system takes a share.
- A **taint** with no matching toleration.
- A **single-writer volume** already attached elsewhere, so the pod cannot start
  on a different node.

Orchard surfaces the reason in plain English on the app rather than leaving you
to decode the raw event.
