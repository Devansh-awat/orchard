---
title: Manage organizations and roles
description: Invite members to an Orchard organization, assign organization and project roles, and share registry credentials across projects.
sidebar:
  order: 1
---

To control who can access your Orchard resources, add people to an organization and assign them roles. An organization owns projects and holds members, quotas, SSO settings, and audit logs. A person can belong to more than one organization.

## Organization roles

| Role       | Permissions                                                                        |
| ---------- | ---------------------------------------------------------------------------------- |
| **Owner**  | Everything an admin can do. Owners also change SSO settings, manage SCIM, and set the vanity address. |
| **Admin**  | Manage members, organization settings, and every project in the organization.       |
| **Member** | Create projects. Open only the projects they create or are added to.               |
| **Guest**  | Open only the projects they are added to. Guests cannot create projects.           |

## Project roles

Owners and admins can open every project. Members and guests need a project role for each project.

| Role       | Permissions                                                         |
| ---------- | ------------------------------------------------------------------- |
| **Admin**  | Full control of the project, including deletion and members.        |
| **Member** | Full control of the project, except adding members and deleting it. |
| **Viewer** | Read only.                                                          |

Two people in the same organization can therefore see different lists of apps.

## Invite a member

Owners and admins can invite members.

1. Go to **Organization settings** > **Members**.
2. Select **Invite**.
3. Enter the email address.
4. Select **Member**, **Admin**, or **Owner**.
5. Select **Send invite**.

The invitation appears under **Pending invitations**. If the instance has no email configured, the invitation is a link that you send yourself.

To resend or cancel an invitation, use the controls on its row. The person joins the organization when they accept the invitation.

## Change a member's role

Owners can change roles.

1. Go to **Organization settings** > **Members**.
2. In the member's row, select a new role.

Use the role filter above the table to list **Owners**, **Admins**, **Members**, or **Guests**.

## Add registry credentials

Use organization registry credentials to let every project in the organization pull private images and build from them. Owners and admins can manage these credentials. The instance must have `SECRETS_ENCRYPTION_KEY` set.

1. Go to **Organization settings** > **Registry credentials**.
2. Select **Add**.
3. In **Registry**, select a registry. To share a Docker Hardened Images credential, select **Docker Hardened Images (dhi.io)**.
4. Enter the **Username** and token. For a custom registry, also enter the **Host**.
5. Select **Add credential**.

Orchard encrypts registry tokens at rest. The API never returns them.

The following rules decide which credential applies to a registry:

- A project credential overrides the organization credential for the same registry.
- A build can override both with `DOCKER_AUTH_CONFIG` in its resolved build environment.
- For `dhi.io`, a build can also override both with `DHI_USERNAME` and `DHI_TOKEN`. Setting only one of these variables is an error.

To replace a credential, select **Replace** on its row. To delete it, select **Remove**. Changes apply to later builds and image pulls. A running build keeps the credentials it started with.

Removing a project credential restores the organization credential. Removing an organization credential does not change project credentials.

## Superadmins

A superadmin operates the instance. This role is separate from organization roles. A superadmin can administer every organization and manage instance settings, nodes, and node pools at **Instance admin**.

A new instance has no superadmin. The first superadmin claims the instance with a single-use setup token. For more information, refer to [Install](/start/install/#claim-the-instance).

## Related resources

- [Set up SSO](/teams/sso/)
- [Set up SCIM provisioning](/teams/scim/)
- [Set quotas](/teams/quotas/)
