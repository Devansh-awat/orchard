---
title: Concepts
description: Orchard organizes work into organizations, projects, environments, apps, and databases, and extends an instance with grafts such as Greenhouse. Each environment maps to one Kubernetes namespace.
sidebar:
  order: 4
---

Orchard groups resources in a fixed hierarchy. Access rules, variables, and Kubernetes namespaces all follow it, so once you know where a resource sits, you know who can reach it and which variables it can read.

```text
Organization
└── Project
    └── Environment
        ├── App
        │   ├── Ports
        │   ├── Domains
        │   └── Volumes
        ├── Database
        ├── Job
        ├── Compose stack
        └── Template instance
```

## Organization

An organization holds members, [quotas](/teams/quotas/), [SSO configuration](/teams/sso/), and [audit logs](/teams/audit-logs/). A person can belong to more than one organization.

## Project

A project groups the apps and databases that belong together, such as the frontend, the API, and the database of one product. [Project membership](/teams/projects/#add-a-member) controls access. A person who is not an organization owner or admin sees only the projects they belong to.

## Environment

An environment is a named part of a project, such as production or staging, with its own apps and variables. Each project has a default environment, named `Production` unless you rename it.

Each environment has its own Kubernetes namespace. Apps in the same environment reach each other by their internal addresses. Environments also hold [shared variables](/run/environments/#shared-variables).

## App

An app is one deployable unit. It has [an image](/deploy/image/), a replica count, [ports](/deploy/networking/), [variables](/run/environments/), [CPU and memory sizes](/deploy/scaling/#set-cpu-and-memory), and optional [volumes](/deploy/storage/).

In Kubernetes terms, an app is a Deployment and its Services, Ingresses, and PersistentVolumeClaims. The API and the CLI call an app a deployment.

## Database

A database is a [managed Postgres instance](/data/databases/) that runs as a CloudNativePG `Cluster`. CloudNativePG is the Kubernetes operator that handles failover, storage, and [backups](/data/backups/). A database has its own lifecycle, separate from any app that connects to it, so you can roll back an app without touching its data, or restore the data without a redeploy.

## Status

Orchard reads status from the cluster. A pod that runs but fails its health check shows as failing. An app with a build in progress shows the build state.

Orchard keeps a copy of cluster state in Postgres, so the dashboard loads quickly and stays available while the API restarts. Kubernetes remains the source of truth. A failed read does not mark a resource as gone. Only a 404 response from Kubernetes does.

## Roles

Organizations and projects each have their own roles.

| Organization role | Access                                                                |
| ----------------- | --------------------------------------------------------------------- |
| Owner             | All actions, including deleting the organization.                     |
| Admin             | Manage members, projects, quotas, and settings.                       |
| Member            | Create projects, and access the projects they create or are added to. |
| Guest             | Access only the projects they are added to.                           |

| Project role | Access                                           |
| ------------ | ------------------------------------------------ |
| Admin        | Manage members and all resources in the project. |
| Member       | Create and edit project resources.               |
| Viewer       | Read-only access.                                |

Superadmin is a separate role for the people who operate the instance. For more information, refer to [Manage organizations and roles](/teams/organizations/).

## Graft

A graft is an extension that adds features to an Orchard instance without a fork. You could think of it as a plugin that the operator installs for the whole instance. A graft can add pages, API endpoints, its own database tables, [MCP tools](/mcp/), and settings in **Instance admin**.

A graft runs inside the Orchard server with the same access as Orchard. It reaches Orchard through versioned interfaces, and it keeps its data in its own Postgres schema. If a graft fails to load, Orchard skips it and still starts. Because a graft is not sandboxed, install only grafts that you trust. For more information, refer to [Grafts](/grafts/overview/).

## Greenhouse

Greenhouse is a first-party graft that runs coding agents on cloud machines. A machine is an isolated Linux environment with your repositories on it. Each agent session works on its own branch in its own git worktree, so several sessions can run on one machine at once.

Greenhouse is for writing code, not for serving traffic. To run what you build, deploy it to Orchard as an app. Greenhouse is available only on instances where an operator has installed it. For more information, refer to [Greenhouse](/greenhouse/).

## Related resources

- [Deploy your first app](/start/first-deploy/) - Deploy a repository and connect a Postgres database to it.
- [Manage a project](/teams/projects/) - Add members to a project and manage its environments.
- [Architecture](/operate/architecture/) - Learn which components make up an Orchard instance and how they connect.
