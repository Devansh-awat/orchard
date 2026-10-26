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

## Registry credentials

Owners and admins can open **Organization settings → Registry credentials** to
save a Docker registry hostname, username and token. Choose **Docker Hardened
Images (dhi.io)** to share a DHI login across all projects. Tokens are encrypted
at rest and are never returned by the API; the instance must have
`SECRETS_ENCRYPTION_KEY` configured.

The defaults apply to builds and to private images used by apps and jobs in
existing and new projects. For each registry, a project credential overrides
the organization credential. Builds can override both with `DOCKER_AUTH_CONFIG`
or, for `dhi.io`, a complete `DHI_USERNAME` and `DHI_TOKEN` pair in their resolved
build environment. Setting only one DHI variable is an error. Registry tokens
are kept out of build arguments and Railpack application secrets.

Replace a credential by saving another login for the same registry, or remove
it with the trash button. Changes update project image-pull secrets and apply
to subsequent builds and image pulls. Running builds keep the credentials they
started with. Removing a project override restores the organization default;
removing the organization default keeps project overrides intact.
