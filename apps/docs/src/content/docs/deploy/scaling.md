---
title: Scaling and resources
description: Replicas, CPU and memory, and what the numbers actually mean.
sidebar:
  order: 5
---

## Replicas

The replica slider on an app's overview changes how many copies run. Rolling
updates mean a deploy does not drop traffic as long as more than one replica is
up and health checks pass.

## CPU and memory

Sizes are chosen per app, in millicores and MiB (or cores and GiB).

**Requests equal limits.** What you pick is what the app gets, and what it is
capped at. This avoids the usual trap where a container looks fine until the node
gets busy and it is throttled to its much smaller request.

Sizing honestly matters more than sizing generously: a request that is far above
real usage wastes cluster capacity that someone else in the organization could
have used, and quotas are enforced against requests.

:::caution
When changing resources through the API, send every field you want to keep.
Omitting a value does not mean "leave it alone". It falls back to the
organization default, which may be smaller than what the app had.
:::

## Health checks

Health checks gate whether a pod counts as ready, and are re-applied on rebuild
so they do not quietly disappear after a redeploy. An app that is running but
failing its check is reported as such rather than being called healthy.

## Quotas

Every organization can have caps, and each member can have an allowance inside
those caps. The effective limit for a new app is the smaller of what is left in
your allowance and what is left in the organization's cap.

See [Quotas and usage](/teams/quotas/).
