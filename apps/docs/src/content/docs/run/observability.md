---
title: Metrics and alerts
description: Orchard shows CPU, memory, and traffic metrics for apps and lists current problems with apps and databases. Learn where each signal appears.
sidebar:
  order: 6
---

Orchard reports app and database health in three places: metrics over time, a list of current problems, and alert rules that notify you.

## Metrics

Each app shows CPU and memory as a current value and over time on its **Observe** tab. Databases add size, connections, and activity. For the panels on each tab, refer to [Monitor an app](/run/monitor-an-app/) and [Monitor a database](/data/monitoring/).

When you size an app, read the range. `kubectl top` reports one instant, which can mislead you on a workload with spikes. For suggestions based on recent use, refer to [Apply resource suggestions](/deploy/resource-suggestions/).

## Current problems

A project's **Overview** tab, and the top of each app and database page, show a list of what is wrong now, with the worst problem first. The list is hidden when nothing is wrong.

| Problem                             | Applies to         |
| ----------------------------------- | ------------------ |
| Killed for using too much memory    | Apps and databases |
| Crash loop                          | Apps and databases |
| Failed build                        | Apps               |
| Rolled-back release                 | Apps               |
| A change the cluster refused        | Apps               |
| Firing alert                        | Apps               |
| Error spike in the logs             | Apps               |
| Fewer replicas ready than requested | Apps               |

Each row names the resource, shows how long the problem has existed, and links to the action that helps.

## App alerts

Alerts above an app's tabs reflect the current state of the cluster. They include a failing build, a crash-looping pod, resource pressure, and a lost live connection. An alert clears when its condition clears. Short grace windows apply where state can change quickly, so a single restart does not leave a permanent banner.

## Alert rules and notifications

To receive notifications when you are not viewing the dashboard, use these features:

- [Create alert rules](/run/alerts/) to watch a metric on an app.
- [Set up notifications](/run/notifications/) to route events to Slack, Discord, email, or a webhook.
- [Publish a status page](/run/status-pages/) to share health with your users.

## Usage

Organization-wide usage, by project and by person, is on the [Usage page](/teams/usage/).
