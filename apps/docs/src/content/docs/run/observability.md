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

## Anomalies

A project's Apps tab, and the top of every app and database page, carries one
card listing what is wrong right now, worst first: an app killed for memory,
a crash loop, a release that rolled back, a change the cluster refused, a failed
build, a firing alert, an error spike in the logs, or fewer replicas ready than
asked for. Each row names the resource, says how long it has been the case, and
carries the one action that helps. The card is empty most of the time, and it
disappears when it is.

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
