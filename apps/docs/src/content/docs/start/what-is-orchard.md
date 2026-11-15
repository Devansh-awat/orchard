---
title: What is Orchard
description: Orchard is an open-source, self-hosted platform as a service (PaaS) from Hack Club. Install it on your own server or Kubernetes cluster, then deploy apps and Postgres databases from Git, the CLI, or an AI agent.
sidebar:
  order: 1
---

Orchard is an open-source, self-hosted platform as a service (PaaS) from [Hack Club](https://hackclub.com). It gives you the push-to-deploy workflow of a hosted platform on hardware that you control. You connect a Git repository, and Orchard builds the app, runs it behind an HTTPS URL, and runs a managed Postgres database next to it, with backups and point-in-time restore.

Orchard runs on Kubernetes, but you do not need to know Kubernetes to use it. On a single Linux server, one command sets up a k3s cluster and every component Orchard needs. On a cluster that you already operate, a Helm chart installs Orchard on top of it. After that, you work in the dashboard, the CLI, or an AI agent, the same way you would on a hosted platform.

Orchard is free and licensed under [AGPL-3.0](/operate/licenses/). The SDK for building extensions is licensed under MIT. Hack Club runs its own apps on Orchard. There is no hosted version, so you run the instance yourself.

## How it works

1. You install Orchard. The installer sets up k3s, Orchard, a container registry, and the operators for databases and certificates. The Helm chart installs Orchard on a cluster that already has them.
2. You connect a repository from GitHub, GitLab, Gitea, or another Git host. You can also deploy a container image, or deploy a folder from your computer with `orchard up`.
3. Orchard builds an image on your cluster. It uses your Dockerfile, or it detects your language and builds the app without one.
4. Orchard runs the app, routes HTTPS traffic to it, and keeps it running. By default, the new version must be ready before Orchard stops the old one.
5. Each push to the branch that you choose deploys again. If a deploy goes wrong, you roll back to an earlier build.

Your apps and databases run as normal Kubernetes workloads, so they do not depend on the Orchard dashboard or API. If Orchard itself stops, your apps keep serving traffic, and only new deploys and changes wait until it is back. For the components and how they connect, refer to [Architecture](/operate/architecture/).

## Who it is for

- Developers and students who want push-to-deploy hosting on a VPS or a home server, without learning DevOps.
- Teams that want one platform for their apps, databases, and jobs, with roles, single sign-on (SSO), and audit logs.
- People who already run Kubernetes and want a PaaS on top of it. They install the [Helm chart](/start/install/#install-on-an-existing-cluster) instead of the installer.

## Features

| Feature       | Description                                                                                                    | Refer to                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Deployments   | Deploy from GitHub, GitLab, Gitea, or another Git host, from a container image, or from a folder.              | [Deploy from GitHub](/deploy/github/)                   |
| Builds        | Build from a Dockerfile, or without one. Builds run on your cluster and stream their logs.                     | [Builds](/deploy/builds/)                               |
| Routing       | Give each app an HTTPS URL, custom domains, and access protection.                                             | [Manage domains and HTTPS](/deploy/domains/)            |
| Databases     | Run Postgres with backups, point-in-time restore, forks, read replicas, and major upgrades.                    | [Create and manage a database](/data/databases/)        |
| Jobs          | Run multi-step jobs on a cron schedule or on demand.                                                           | [Run jobs and pipelines](/run/jobs/)                    |
| Observability | Search logs, read metrics and requests, and open a shell in a running container.                               | [Read logs and open a shell](/run/logs/)                |
| Teams         | Manage organizations, roles, SSO, audit logs, and quotas.                                                      | [Manage organizations and roles](/teams/organizations/) |
| Interfaces    | Use the dashboard, the CLI, the [Model Context Protocol (MCP) server](/mcp/), or [Terraform](/run/terraform/). | [Use the CLI](/cli/)                                    |
| Extensions    | Add pages, API endpoints, and MCP tools with grafts, which are extensions that the operator installs.          | [Grafts](/grafts/overview/)                             |

A graft is an extension that adds features to an Orchard instance without a fork. Orchard publishes its own grafts, such as [Greenhouse](/greenhouse/), which runs coding agents on cloud machines. For the full feature list, refer to [Features](/start/features/). To compare Orchard with other self-hosted platforms, refer to [Compare](https://orchard.hackclub.com/compare).

## Choose how to run Orchard

Orchard runs the same way in both setups. What changes is how much of the cluster underneath it you operate.

| Setup                                                               | What you get                                                                                                                                                                  | Use it for                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [One-command installer](/start/install/#install-on-a-linux-machine) | A single-node k3s cluster on one Linux machine, with `local-path` disks, a zot registry, and an S3 store for backups on the same machine. The installer configures all of it. | A home lab, a side project, a small team, or a trial |
| [Helm chart](/start/install/#install-on-an-existing-cluster)        | Orchard on a cluster that you build and operate. You choose the registry, the storage, the backup store, and the number of nodes.                                             | A production setup                                   |

The installer's limit is its single-node layout, not k3s. Everything runs on one machine, so that machine is a single point of failure. Backups in the store on the server are lost with it, unless you send backups to [S3 storage](/operate/storage/) off the machine. Adding more nodes to an installer host is not supported yet. For details, refer to [Add and remove nodes](/operate/nodes/#add-and-remove-nodes).

For production, Orchard recommends the Helm chart on a multi-node cluster built for it, such as [Talos Linux](https://docs.siderolabs.com/talos). On that cluster, you can replace the bundled components with ones that you operate:

- [Harbor](https://goharbor.io/docs/) or another OCI registry instead of zot. Refer to [Turn on image builds](/start/install/#turn-on-image-builds).
- External S3-compatible storage instead of the store on the server. Refer to [Add S3 storage](/operate/storage/).
- A replicated StorageClass instead of `local-path`, set with `tenant.storageClass` and the `storageClass` of each volume in the chart.

Before you go live on either setup, work through [Go to production](/operate/production/).

## Limitations

- Orchard is not fully tenant-isolated by default. Apps cannot reach each other over the network, but they share the host kernel, and builds run on it too. Before you let people you do not trust deploy code, install gVisor and Kata and follow [Requirements for untrusted code](/operate/security/#requirements-for-untrusted-code).
- Orchard uses Kubernetes words where they matter. Pods, replicas, and namespaces appear in the dashboard under those names.
- Managed databases are Postgres only. Other databases, such as MariaDB or MongoDB, run as apps from [templates](/run/templates/).

## Related resources

- [Install](/start/install/) - Run the installer on a Linux machine, or install the Helm chart on your cluster.
- [Deploy your first app](/start/first-deploy/) - Deploy a repository and connect a Postgres database to it.
- [Concepts](/start/concepts/) - Learn how organizations, projects, environments, and apps fit together.
- [FAQ](/start/faq/) - Read short answers about production use, security, and licensing.
