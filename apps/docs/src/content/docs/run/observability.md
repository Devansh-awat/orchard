---
title: Metrics and alerts
description: CPU, memory, and knowing when something is wrong.
sidebar:
  order: 6
---

## Metrics

Every app shows **CPU** and **memory**, both as a current number and over time.
Databases add size, connections and activity.

The numbers come from the cluster's own metrics pipeline, which matters when you
are right-sizing: `kubectl top` reports an instantaneous sample and will happily
mislead you about a spiky workload. Look at the range, and size against the peak
you actually care about rather than the number that happened to be on screen.

## Alerts

Deployment alerts appear above an app's tabs and reflect **current cluster
state**: a failing build, a crash-looping pod, resource pressure, a lost live
connection. They clear when the condition clears, because they mirror reality
rather than counting down a timer.

Grace windows exist where state genuinely flaps, so a pod that restarts once does
not produce a permanent banner.

## Notifications

For things you want to know about while you are not looking at the dashboard, see
[Notifications](/run/notifications/).

## Usage

Organization-wide consumption, per project and per person, lives on the
[Usage page](/teams/quotas/).
