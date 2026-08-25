---
title: Organizations and roles
description: Who can do what, and how access is scoped.
sidebar:
  order: 1
---

## Organizations

An organization owns projects, holds members, and is where quotas, SSO and audit
logs are configured. People can belong to more than one and switch between them.

## Roles

| Role       | Can                                                    |
| ---------- | ------------------------------------------------------ |
| **Owner**  | Everything, including deleting the organization        |
| **Admin**  | Manage members, projects, quotas, domains and settings |
| **Member** | Create and manage resources in projects they belong to |
| **Viewer** | Read                                                   |

## Project membership is the real boundary

Being in an organization does not give you every app in it. **Project membership
gates access to the deployments inside that project.** Add someone to a project
and they get its apps and databases; leave them out and they do not.

This is worth understanding because it explains two things that look
inconsistent:

- Two people in the same organization can see different lists of apps.
- Two people in the same _project_ can see different **GitHub repositories**,
  because repository access comes from each person's own GitHub link rather than
  from the project.

## Invitations

Invite by email. The invitation carries a role, and the person picks up the
organization when they accept. Invitations can be revoked before they are used.

## Superadmin

Superadmin is an instance-level role for whoever operates the platform, separate
from organization roles. It can see and administer every organization, manage
nodes and node pools, and change instance settings.

On a fresh install nobody is superadmin. The first one claims the instance with a
single-use setup token; see [Install](/start/install/#claiming-the-instance).
