---
title: What is Orchard
description: Orchard is an open-source, self-hosted platform as a service (PaaS) from Hack Club. One command installs it on your own server, and you do not need to know Kubernetes.
sidebar:
  order: 1
---

Orchard is an open-source, self-hosted platform as a service (PaaS) from [Hack Club](https://hackclub.com). It runs on a server you own. One command installs it on a Linux server. Then you connect a Git repository, and Orchard builds the app, runs it, gives it an HTTPS URL, and runs a Postgres database next to it.

Orchard runs on Kubernetes, but you do not need to know Kubernetes. The installer sets up a single-node k3s cluster and every component Orchard needs, and Orchard manages the cluster for you. You use the dashboard, the CLI, or an AI agent, the same way you use a hosted platform.

Orchard is free and licensed under [AGPL-3.0](/operate/licenses/). The graft SDK is licensed under MIT. Hack Club runs its own apps on it. There is no hosted version, so you run the instance yourself.

## How it works

1. You run the installer on a Linux server. It installs k3s, Orchard, a container registry, and the operators for databases and certificates.
2. You connect a repository from GitHub, GitLab, Gitea, or another Git host, or you deploy a folder from your computer with `orchard up`.
3. Orchard builds an image. It uses your Dockerfile, or it detects your language and builds the app without one.
4. Orchard runs the app, routes HTTPS traffic to it, and keeps it running. A new version must be ready before Orchard stops the old one.
5. Each push to the branch you choose deploys again. If a deploy goes wrong, you roll back to an earlier build.

Your apps and databases run as normal Kubernetes workloads. If the Orchard dashboard or API stops, your apps keep running and keep serving traffic. Only new deploys and changes wait until Orchard is back. For the components, refer to [Architecture](/operate/architecture/).

## Who it is for

- Developers and students who want push-to-deploy hosting on a cheap VPS or a home server, without learning DevOps.
- Teams that want one platform for their apps, databases, and jobs, with roles, SSO, and audit logs.
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
| Teams         | Manage organizations, roles, single sign-on (SSO), audit logs, and quotas.                                     | [Manage organizations and roles](/teams/organizations/) |
| Interfaces    | Use the dashboard, the CLI, the [Model Context Protocol (MCP) server](/mcp/), or [Terraform](/run/terraform/). | [Use the CLI](/cli/)                                    |

For the full list, refer to [Features](/start/features/). To compare Orchard with other self-hosted platforms, refer to [Compare](https://orchard.hackclub.com/compare).

## Limitations

- The one-command installer creates a single-node k3s cluster. To use an existing cluster, you install the Helm chart and provide the operators it depends on. For the list, refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).
- Orchard is not fully tenant-isolated by default. Apps cannot reach each other over the network, but they share the host kernel, and builds run on it too. Before you let people you do not trust deploy code, turn on gVisor and Kata and follow [Requirements for untrusted code](/operate/security/#requirements-for-untrusted-code).
- Orchard uses Kubernetes words where they matter. Pods, replicas, and namespaces appear in the dashboard under those names.

## Related resources

- [Install](/start/install/)
- [Deploy your first app](/start/first-deploy/)
- [Architecture](/operate/architecture/)
- [Go to production](/operate/production/)
- [Grafts](/grafts/overview/)
- [Greenhouse](/greenhouse/)
