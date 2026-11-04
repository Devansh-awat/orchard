---
title: Concepts
description: Orchard organizes work into organizations, projects, environments, apps, and databases. Each environment maps to one Kubernetes namespace.
sidebar:
  order: 4
---

Orchard groups resources in a fixed hierarchy. Access rules, variables, and Kubernetes namespaces all follow this hierarchy.

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

An organization holds members, quotas, SSO configuration, and audit logs. A person can belong to more than one organization.

## Project

A project groups the apps and databases that belong together. Project membership controls access. A person who is not an organization owner or admin sees only the projects they belong to.

## Environment

An environment is a named part of a project. Each project has a default environment, named `Production` unless you rename it.

Each environment has its own Kubernetes namespace. Apps in the same environment reach each other by their internal addresses. Environments also hold [shared variables](/run/environments/#shared-variables).

## App

An app is one deployable unit. It has an image, a replica count, ports, variables, CPU and memory sizes, and optional volumes.

In Kubernetes terms, an app is a Deployment and its Services, Ingresses, and PersistentVolumeClaims. The API and the CLI call an app a deployment.

## Database

A database is a managed PostgreSQL instance that runs as a CloudNativePG `Cluster`. CloudNativePG is the Kubernetes operator that handles failover, storage, and backups. A database has its own lifecycle, separate from any app that connects to it.

## Status

Orchard reads status from the cluster. A pod that runs but fails its health check shows as failing. An app with a build in progress shows the build state.

Orchard keeps a copy of cluster state in PostgreSQL, so the dashboard loads quickly and stays available while the API restarts. Kubernetes remains the source of truth. A failed read does not mark a resource as gone. Only a 404 response from Kubernetes does.

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
