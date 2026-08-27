---
title: Logs and shell
description: Live logs, crash reports, and a terminal inside the running container.
sidebar:
  order: 5
---

## Live logs

An app's **Overview** streams logs as they happen. Filter by **pod** when an app
has several replicas and you want one, and by **time range** when you know
roughly when something happened.

Logs stream over a live connection, so a busy app fills the panel in real time
rather than on a poll.

## Crash reports

The logs that matter most belong to a container that already died, and those are
normally gone by the time you look. Orchard keeps them: when a container is
killed, its final output is captured and attached to the app, including OOM
kills.

This is what turns "it says CrashLoopBackOff" into "it says
`Error: Cannot find module 'pg'` on line 3".

Managed databases get the same treatment, under **Terminal → Killed**. A
Postgres container that gets OOMKilled is replaced fast enough that its logs are
usually gone before anyone looks, and those logs are exactly where Postgres
explains itself.

The **Previous** toggle on the logs view is the live equivalent: it reads the
container that died rather than the one running now.

## Reading a crash loop

A crash loop is: the container starts, exits, Kubernetes restarts it, repeat. The
useful signal is the **exit reason and the last logs**, both surfaced on the app.

| Symptom                                       | Usually                                                               |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Exits immediately, module or import error     | The image is missing a dependency, or the wrong build stage was used  |
| Exits after a few seconds, connection refused | It cannot reach its database, check the internal host and credentials |
| Killed, exit 137                              | Out of memory, raise the limit or fix the leak                        |
| Runs but never becomes ready                  | The health check path or port is wrong                                |

## Shell

**Shell** opens a terminal inside the running container, over the same
authentication as the dashboard. Use it to look at the filesystem, check
environment variables as the process sees them, or run the app's own CLI.

It is a real process in a real pod: anything you change is lost on the next
restart, and a command that eats the container's memory will get it killed.

## Kubernetes-level events

Cluster events are translated into plain English rather than shown raw, so an
unschedulable pod says what it is waiting for. The underlying reason is still
there when you need it.

**Observe → Events** lists the warnings Kubernetes recorded for the app's pods,
newest first, with how many times each one repeated. This is the history:
failed scheduling, image pull problems, probe failures, volume mounts. The alert
banner above the tabs is deliberately different, showing only what is wrong
_now_, because Kubernetes keeps warning events for about an hour after the
problem clears and a banner that stale is worse than none.
