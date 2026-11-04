---
title: What is Orchard
description: Orchard is an open-source, self-hosted platform as a service (PaaS) that builds, runs, and routes apps on a Kubernetes cluster you control.
sidebar:
  order: 1
---

Orchard is an open-source platform as a service (PaaS). You install it on a Kubernetes cluster you control. Orchard builds apps from a Git repository or runs them from a container image, routes HTTPS traffic to them, and manages Postgres databases for them.

Orchard is licensed under [AGPL-3.0](/operate/licenses/). There is no hosted version, so you run the instance yourself.

## Get started

- [Install](/start/install/): Install Orchard on a Linux machine or a Kubernetes cluster.
- [Deploy your first app](/start/first-deploy/): Deploy a repository and connect a database.
- [Concepts](/start/concepts/): Learn how organizations, projects, environments, and apps relate.

## Features

| Feature       | Description                                                                                                    | Refer to                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Deployments   | Deploy from GitHub, other Git hosts, or a container image.                                                     | [Deploy from GitHub](/deploy/github/)                   |
| Builds        | Build images in jobs on your cluster and stream the logs.                                                      | [Builds](/deploy/builds/)                               |
| Routing       | Give each app an HTTPS URL, custom domains, and access protection.                                             | [Manage domains and HTTPS](/deploy/domains/)            |
| Databases     | Run Postgres with backups, checkpoints, point-in-time restore, and read replicas.                              | [Create and manage a database](/data/databases/)        |
| Jobs          | Run multi-step jobs on a cron schedule or on demand.                                                           | [Run jobs and pipelines](/run/jobs/)                    |
| Observability | Search logs, read metrics and requests, and open a shell in a running container.                               | [Read logs and open a shell](/run/logs/)                |
| Teams         | Manage organizations, roles, single sign-on (SSO), audit logs, and quotas.                                     | [Manage organizations and roles](/teams/organizations/) |
| Interfaces    | Use the dashboard, the CLI, the [Model Context Protocol (MCP) server](/mcp/), or [Terraform](/run/terraform/). | [Use the CLI](/cli/)                                    |

## Limitations

- The one-command installer creates a single-node k3s cluster. To use an existing cluster, you install the Helm chart and provide the operators it depends on. For the list, refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).
- Apps are network-isolated by default, but they share the host kernel. Kernel isolation with gVisor or Kata is optional and needs runtimes on your nodes. For more information, refer to [Security and isolation](/operate/security/).
- Orchard does not hide Kubernetes. Pods, replicas, and namespaces appear in the dashboard under those names.

## Related resources

- [Architecture](/operate/architecture/)
- [Go to production](/operate/production/)
- [Grafts](/grafts/overview/)
- [Greenhouse](/greenhouse/)
