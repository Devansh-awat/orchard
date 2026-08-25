---
title: What is Orchard
description: Orchard is a self-hosted platform layer for Kubernetes, in the spirit of Coolify or Dokploy but Kubernetes-native.
sidebar:
  order: 1
---

Orchard installs into a Kubernetes cluster you control and gives the people using
that cluster a platform instead of a pile of YAML. Connect a GitHub repo, and
Orchard builds it, runs it, routes traffic to it, gives it a database, and shows
you the logs when it breaks.

It is in the same family as Coolify and Dokploy: something you run yourself, on
your own hardware, that makes deploying feel like a hosted platform. The
difference is what it targets. Orchard schedules onto Kubernetes, so it inherits
replicas, rolling updates, health checks, resource quotas, and node scheduling
rather than reimplementing them.

## What you get

|                |                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| **Deploys**    | GitHub repos or container images, with builds on the cluster and streaming logs                               |
| **Routing**    | An HTTPS URL per app, custom domains with automatic certificates, an auth wall if you want one                |
| **Data**       | Managed PostgreSQL with backups, extensions, read replicas, and a query console                               |
| **Jobs**       | Cron schedules and multi-step pipelines, with per-step output and exit codes                                  |
| **Visibility** | Live logs filtered by pod and time, CPU and memory over time, crash reports from containers that already died |
| **Teams**      | Organizations, projects, roles, SSO, SCIM provisioning, audit logs, quotas                                    |
| **Interfaces** | A web dashboard, a CLI, and an MCP server so agents can drive it                                              |

## What it is not

**Not a hosted service.** There is no orchard.com you sign up for. You run it.

**Not a Kubernetes installer.** The one-command installer will stand up k3s for
you on a bare box, but on an existing cluster Orchard expects you to bring the
platform layer underneath it: a Postgres operator, an ingress controller,
cert-manager, a storage class, a registry. See
[Install](/start/install/#an-existing-cluster).

**Not hardened for untrusted code out of the box.** Deployments are
network-isolated by default, but kernel isolation (gVisor, Kata) is opt-in and
needs node-level runtimes. See [Security and isolation](/operate/security/).

**Not an abstraction that hides Kubernetes.** Pods, replicas and namespaces are
still there, and the UI names them. Orchard is a better front door, not a
disguise.

## How it fits together

Your cluster runs the Orchard control plane (an API server, a web frontend, a
Redis, a control-plane Postgres, image builders) alongside tenant namespaces
holding the apps people deploy. Builds run as jobs on the cluster and push to a
registry you configure. The API mirrors cluster state into Postgres so reads are
fast and survive an API server restart.

More detail in [Architecture](/operate/architecture/).
