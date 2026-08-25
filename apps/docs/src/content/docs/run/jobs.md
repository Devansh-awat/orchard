---
title: Jobs and pipelines
description: Cron schedules and multi-step runs on the cluster.
sidebar:
  order: 2
---

Jobs run work that is not a long-lived server: nightly cleanups, imports,
migrations, report generation. They run on the cluster, so they do not depend on
anyone's laptop being awake.

## Building one

A job has a **name**, an optional **schedule**, a **concurrency policy** for when
a run is still going, and one or more **steps**.

Steps come in three shapes:

| Step         | Runs                                               |
| ------------ | -------------------------------------------------- |
| Script       | `bash`, `python` or `node` source you type in      |
| App command  | A command inside one of your existing apps' images |
| Custom image | Any container image with your own command          |

Steps run in order. Each has its own logs and exit code, so a five-step pipeline
tells you which step failed rather than just failing.

## Scheduling

A schedule turns the job into a cron job on the cluster. Without one it only runs
when triggered, from the dashboard, the CLI, or an MCP tool.

The concurrency policy decides what happens when the previous run has not
finished: skip the new one, queue it, or run both.

## Reading a run

Each run has a status, a duration, and per-step output. Runs are kept, so you can
compare a failing run to the last good one.

:::caution
A step that ends `|| true` always reports success. That is occasionally what you
want and usually not: it turns a broken job into a green one. If you swallow a
failure, make sure the job still fails on the thing that actually matters.
:::

## The image matters

Script steps run in a stock image for the language you picked. That image is
deliberately small, so tools you assume are present may not be: a `debian:12-slim`
base has no `curl` and no `wget`. If a step needs a tool, use a **custom image**
that has it, or install it as the first line of the script.
