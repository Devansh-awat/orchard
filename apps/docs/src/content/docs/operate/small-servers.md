---
title: Run on a small server
description: Run Orchard on a server with 2 to 4 GiB of RAM, and leave as much memory as possible for your apps.
sidebar:
  order: 6
---

Orchard runs on 2 GiB of RAM. 8 GB is recommended. On a small server, the installer gives Orchard its smallest footprint, so that most of the memory stays free for your apps. Below 3.5 GiB, it also starts with the MCP endpoint and image scanning turned off, because each one holds memory all the time.

## What the installer changes

The installer reads the RAM of the server when it runs.

| RAM            | Profile                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| Under 2 GiB    | The installer warns that Orchard leaves little or no room for apps, and continues. |
| 2 to 3.5 GiB   | The smallest profile. Refer to [The smallest profile](#the-smallest-profile).      |
| 3.5 to 8 GiB   | Metrics, logs, and the scanner use lower requests, and 7 days of logs are kept.    |
| 8 GiB and more | The defaults.                                                                      |

### The smallest profile

Under 3.5 GiB of RAM, a new install:

- Gives the control plane small memory requests. A request is the memory the scheduler keeps free for a pod, so small requests leave room to schedule your apps. The limits stay high, so a pod that needs more memory for a moment can use it.

  | Pod        | Memory request | Memory limit |
  | ---------- | -------------- | ------------ |
  | `server`   | 192 MiB        | 1 GiB        |
  | `frontend` | 64 MiB         | 512 MiB      |
  | Postgres   | 256 MiB        | 1 GiB        |
  | Redis      | 32 MiB         | 256 MiB      |

- Limits the Node.js heap of the server to 512 MiB and of the dashboard to 192 MiB, with `NODE_OPTIONS`.
- Requests 512 MiB for each build, instead of 2 GiB, with `BUILDER_MEMORY_REQUEST`. A build can still use more memory up to its limit. A large build can run out of memory on a small server. To build somewhere else, refer to [Build outside the server](#build-outside-the-server).
- Turns off the MCP endpoint and image scanning, unless you pass `--mcp true`, `--mcp-domain`, or `--image-scanning true`. To turn them on later, run `sudo orchardctl mcp enable --apply`, or `sudo orchardctl config set trivy.enabled true --apply`.

The installer applies this profile to a new install only. A re-run of the installer keeps the values that are already in `/etc/orchard/values.yaml`. To use a value from the profile on an existing install, set it with `sudo orchardctl config set` or `sudo orchardctl env set`.

## Save more memory

These parts of Orchard are optional. Each one uses memory all the time.

| Part             | Memory request | To turn it off at install | To turn it off later                                       |
| ---------------- | -------------- | ------------------------- | ---------------------------------------------------------- |
| Metrics          | About 210 MiB  | `--metrics false`         | `sudo orchardctl config set metrics.enabled false --apply` |
| Logs             | About 160 MiB  | `--logs false`            | `sudo orchardctl config set logs.enabled false --apply`    |
| Image scanning   | 256 MiB        | `--image-scanning false`  | `sudo orchardctl config set trivy.enabled false --apply`   |
| The MCP endpoint | 128 MiB        | `--mcp false`             | `sudo orchardctl mcp disable --apply`                      |

Without metrics, the dashboard does not show charts of CPU, memory, and requests. Without logs, the dashboard shows only the logs of running pods, not their history.

## Datadog

Orchard sends traces and profiles to Datadog only when you turn it on. The installer and the chart leave it off. When it is off, the server does not load the Datadog tracer, which saves about 25 MiB of memory. With the tracer, the profiler, and App and API Protection on, each server pod uses about 100 MiB more.

To turn it on, run a Datadog agent in the cluster and set `datadog.enabled` to `true`. For the values, refer to the [chart reference](https://github.com/hackclub/orchard/tree/main/infra/charts/orchard#datadog-datadog).

## Build outside the server

A build uses the most memory of anything that Orchard does. On a server with 2 GiB of RAM, a large build can fail with an out-of-memory error. To keep builds off the server, build the image in CI, push it to a registry, and deploy the image. For more information, refer to [Deploy an image](/deploy/image/).

An installer host cannot take a second node for builds. If you outgrow one machine, run the Helm chart on a multi-node cluster and [reserve a node for builds](/operate/nodes/#control-where-builds-run). For the reasons, refer to [Add and remove nodes](/operate/nodes/#add-and-remove-nodes).

## Free disk space

A small server usually has a small disk too. To keep the build cache and old images from filling it, refer to [Free disk space](/operate/disk-space/).

## Related resources

- [Install](/start/install/) - Install Orchard on a Linux machine with the one-command installer.
- [Scale the control plane](/operate/scale-control-plane/) - Resize the metrics stack and the control-plane pods with chart values.
