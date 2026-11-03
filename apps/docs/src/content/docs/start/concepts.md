---
title: Concepts
description: Organizations, projects, apps, environments and how they nest.
sidebar:
  order: 4
---

Orchard has a small object model. Everything else hangs off it.

## The nesting

```
Organization
└── Project
    ├── App (deployment)
    │   ├── Service and ports
    │   ├── Ingress (domain)
    │   └── Volumes
    ├── Database
    ├── Job
    └── Compose stack / Template instance
```

### Organization

The billing-and-people boundary. Members, roles, quotas, SSO configuration and
audit logs all live at this level. A person can belong to several.

Each organization gets its own Kubernetes namespace per project, so tenants are
separated at the cluster level rather than only in the UI.

### Project

A grouping of apps and databases that belong together, owned by an organization.
Project membership is what gates access to the deployments inside it, so adding
someone to a project gives them the apps in it.

Projects carry shared variables and an icon and background of their own.

### App

One deployable unit: an image, a number of replicas, ports, environment,
resources and storage. In Kubernetes terms it is a Deployment plus the Service,
Ingress and PersistentVolumeClaims around it.

Apps come from a GitHub repo (Orchard builds the image) or directly from a
container image.

### Environment

A named slice of a project, `Production` by default. Variables can be scoped to
one environment, so staging and production differ without maintaining two
projects.

### Database

A managed PostgreSQL instance, created as a CloudNativePG `Cluster`. It has its
own lifecycle: backups, extensions, read replicas, resource sizing, and optional
public exposure.

## Status, and where it comes from

Statuses in the UI reflect what the cluster actually reports, not a timer. A pod
that is running but failing its health check says so; an app whose build is in
flight shows the build state, because a build in progress dominates.

Orchard mirrors cluster state into Postgres through informers, so the dashboard
stays fast and keeps working across an API restart. When the mirror and the
cluster disagree, the cluster wins.

## Roles

| Role   | Can                                                    |
| ------ | ------------------------------------------------------ |
| Owner  | Everything, including deleting the organization        |
| Admin  | Manage members, projects, quotas and settings          |
| Member | Create and manage resources in projects they belong to |
| Viewer | Read-only                                              |

Superadmin is separate: an instance-level role for whoever operates the platform.
See [Organizations and roles](/teams/organizations/).
