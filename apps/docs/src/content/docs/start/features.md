---
title: Features
description: The full list of features in Orchard, the open-source PaaS from Hack Club, from Git deploys and builds without a Dockerfile to managed Postgres with point-in-time restore, jobs, SSO, and an MCP server for agents.
sidebar:
  order: 2
---

This page lists what an Orchard instance can do. Every feature is part of the open-source code, and there is no paid tier. Some features need the operator to set them up first, such as Greenhouse or kernel sandboxing with gVisor or Kata. For an introduction to Orchard, refer to [What is Orchard](/start/what-is-orchard/).

## Deploy

| Feature              | Description                                                                                          | Refer to                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Deploy from GitHub   | Pick a repository and a branch. With the GitHub App, each push deploys again.                        | [Deploy from GitHub](/deploy/github/)                           |
| Other Git hosts      | Deploy from GitLab, Gitea, Forgejo, Codeberg, or Bitbucket Cloud, with auto-deploy on push.          | [Deploy from GitLab, Gitea, and others](/deploy/git-providers/) |
| Deploy from a folder | Run `orchard up` in a directory to deploy it without a repository. Needs S3 storage on the instance. | [Deploy from the terminal](/deploy/deploy-from-terminal/)       |
| Container images     | Run a prebuilt image from any registry.                                                              | [Deploy an image](/deploy/image/)                               |
| Builds               | Build from a Dockerfile, or let Orchard detect the language and build without one. Logs stream live. | [Builds](/deploy/builds/)                                       |
| Compose stacks       | Deploy a Docker Compose file as a group of apps.                                                     | [Compose stacks](/run/compose/)                                 |
| Templates            | Deploy one of more than 90 ready-made apps, such as a Minecraft server, n8n, or Open WebUI.          | [Templates](/run/templates/)                                    |
| Score files          | Describe ports, variables, and databases in a Score file in the repository.                          | [Score files](/deploy/score/)                                   |

## Run

| Feature               | Description                                                                                                                                 | Refer to                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Safe deploys          | By default, new pods start before old pods stop, except in apps with a volume. Blue/green deploys are available.                            | [Choose an update strategy](/deploy/update-strategies/) |
| Rollbacks             | Go back to an earlier build. With backup storage, restore the app's databases with it.                                                      | [Roll back an app](/deploy/rollbacks/)                  |
| Scaling               | Run more replicas, and set CPU and memory for each app.                                                                                     | [Scale an app](/deploy/scaling/)                        |
| Persistent storage    | Attach volumes to apps that keep files.                                                                                                     | [Storage](/deploy/storage/)                             |
| Variables and secrets | Set variables per app, share them across an environment, and pull them to a local file.                                                     | [Environments and variables](/run/environments/)        |
| Jobs                  | Run multi-step jobs on a cron schedule or on demand.                                                                                        | [Run jobs and pipelines](/run/jobs/)                    |
| Domains and HTTPS     | Each web port can get an HTTPS URL. Add custom domains, and certificates renew on their own. A `lan` install uses self-signed certificates. | [Manage domains and HTTPS](/deploy/domains/)            |
| Access protection     | Require a sign-in or a password before visitors reach an app.                                                                               | [Protect an app](/deploy/protection/)                   |
| Private apps          | Give an app an address on your Tailscale network, without a public URL.                                                                     | [Tailscale](/deploy/tailscale/)                         |

## Databases

| Feature             | Description                                                                                               | Refer to                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Managed Postgres    | Create a Postgres database next to an app and connect it with a reference that survives password changes. | [Create and manage a database](/data/databases/) |
| Backups and restore | Continuous backups to S3-compatible storage, checkpoints, and restore to any moment in the last 30 days.  | [Back up and restore a database](/data/backups/) |
| Forks               | Copy a database to test a change without touching the original.                                           | [Back up and restore a database](/data/backups/) |
| Upgrades            | Upgrade to a new Postgres major version after a rehearsal on a copy, and review known vulnerabilities.    | [Upgrade a database](/data/upgrades/)            |
| High availability   | Run standbys that take over if the primary fails, and send reads to replicas.                             | [High availability](/data/high-availability/)    |
| Connection pooler   | Let many app connections share a small set of database connections.                                       | [Connection pooler](/data/connection-pooler/)    |
| Extensions          | Install Postgres extensions from the dashboard.                                                           | [Extensions](/data/extensions/)                  |

## Observe and secure

| Feature        | Description                                                                                                                                                      | Refer to                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Logs and shell | Search logs, stream them live, and open a shell in a running container.                                                                                          | [Read logs and open a shell](/run/logs/)     |
| Metrics        | Read CPU, memory, and HTTP request metrics for each app. Request metrics need Traefik or HAProxy.                                                                | [Monitor an app](/run/monitor-an-app/)       |
| Notifications  | Send deploy, health, backup, and job events to Slack, Discord, email, or a signed webhook. Email needs SMTP.                                                     | [Set up notifications](/run/notifications/)  |
| Alerts         | Get notified when an app metric stays past a threshold for a set period.                                                                                         | [Create alert rules](/run/alerts/)           |
| Status pages   | Publish a public status page for your apps.                                                                                                                      | [Status pages](/run/status-pages/)           |
| Security tab   | Read configuration findings, image scan results, and attack attempts for each app. Attack attempts need Traefik or HAProxy access logs.                          | [Security tab](/deploy/security-tab/)        |
| Isolation      | Apps cannot reach each other over the network. They share the host kernel unless you turn on gVisor or Kata, so Orchard is not fully tenant-isolated by default. | [Security and isolation](/operate/security/) |

## Teams

| Feature                 | Description                                                            | Refer to                                                |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Organizations and roles | Group people into organizations and projects, each with its own roles. | [Manage organizations and roles](/teams/organizations/) |
| Single sign-on          | Sign in with SAML or OIDC, and provision users with SCIM.              | [Single sign-on](/teams/sso/)                           |
| Audit logs              | Read who changed what, and when.                                       | [Audit logs](/teams/audit-logs/)                        |
| Quotas                  | Cap the CPU and memory that each organization and member can use.      | [Quotas](/teams/quotas/)                                |

## Interfaces

| Feature                | Description                                                                                                                          | Refer to                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Dashboard              | Deploy and manage apps, databases, and teams from the web dashboard.                                                                 | [Deploy your first app](/start/first-deploy/) |
| CLI                    | Deploy, read logs, and roll back from your terminal.                                                                                 | [Use the CLI](/cli/)                          |
| MCP server             | Let Claude, Cursor, or another AI agent deploy apps, add databases, and read logs.                                                   | [MCP server](/mcp/)                           |
| Terraform and OpenTofu | Manage Orchard resources as code. The provider is not on a public registry, so you build it.                                         | [Terraform](/run/terraform/)                  |
| Extensions             | Add pages, API endpoints, and MCP tools with grafts, which are extensions that the operator installs on the instance.                | [Grafts](/grafts/overview/)                   |
| Greenhouse             | Run coding agents on cloud machines, with each session on its own branch. Available when the operator installs the Greenhouse graft. | [Greenhouse](/greenhouse/)                    |
