---
title: Manage organizations and roles
description: Invite members to an Orchard organization, assign organization and project roles, and share registry credentials across projects.
sidebar:
  order: 1
---

An organization is where a team shares Orchard. It owns projects and holds members, quotas, SSO settings, and audit logs. To control who can reach those resources, add people to the organization and give each of them a role. A person can belong to more than one organization, and each organization assigns its own role.

## Organization roles

| Role       | Permissions                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| **Owner**  | Everything an admin can do. Owners also change SSO settings, manage SCIM, and set the vanity address. |
| **Admin**  | Manage members, organization settings, and every project in the organization.                         |
| **Member** | Create projects. Open only the projects they create or are added to.                                  |
| **Guest**  | Open only the projects they are added to. Guests cannot create projects.                              |

## Project roles

Owners and admins can open every project. Members and guests need a [project role](/teams/projects/#add-a-member) for each project.

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

The invitation appears under **Pending invitations**. The person joins the organization when they accept it. To resend or cancel an invitation, use the controls on its row.

### Invite someone when the instance has no email

If the instance has no email configured, Orchard shows a link instead of sending a message. Copy it and send it to the person yourself. `orchard member invite` prints the same link.

- Only organization owners and admins see the link, and only once. Orchard stores a hash of it.
- The link works once and expires after 7 days.
- To get a new link, select the link control on the invitation's row, or run `orchard member invites resend <id>`. The old link stops working.

The link opens a page where the person sets a password or creates a passkey and joins the organization. Their account uses the invited email address. Nothing checks that they own that address, so send the link only to the person you mean to invite. If the address already has an account, they sign in and accept. If single sign-on is enforced, they sign in with that instead.

If they forget the password, someone with root on the server can set a new one with [`orchardctl password set --email <address>`](/operate/host-commands/#password). After you add email to the instance, passwords stop working for everyone except the superadmin, and people sign in with an email code. If the address is not a real mailbox, add a [passkey](/account/security/#add-a-passkey) first.

With email configured, Orchard never shows a link. The person signs in with a code sent to the invited address and accepts the invitation there.

## Change a member's role

Owners can change roles.

1. Go to **Organization settings** > **Members**.
2. In the member's row, select a new role.

Use the role filter above the table to list **Owners**, **Admins**, **Members**, or **Guests**.

## Leave an organization

To leave, go to **Organization settings** > **Members** and select **Leave organization**. If the organization requires single sign-on, the same button is on the page that asks you to sign in.

Leaving removes your memberships in the organization and its projects. Your account and your other organizations do not change. Owners must transfer ownership first, and you cannot leave an organization whose identity provider manages your membership on its verified domain.

## Add registry credentials

Use organization registry credentials to let every project in the organization pull private images and build from them. Owners and admins can manage these credentials. The instance must have [`SECRETS_ENCRYPTION_KEY`](/operate/production/#1-check-your-secrets) set.

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

A superadmin operates the instance. This role is separate from organization roles. A superadmin can administer every organization and manage [instance settings](/operate/instance-admin/), nodes, and [node pools](/operate/nodes/) at **Instance admin**.

A new instance has no superadmin. The first superadmin [claims the instance](/start/install/#claim-the-instance) with a single-use setup token.

## Related resources

- [Set up SSO](/teams/sso/) - Let members sign in with your identity provider.
- [Set up SCIM provisioning](/teams/scim/) - Add and remove members from your directory.
- [Set quotas](/teams/quotas/) - Cap what an organization and each member can use.
- [Read audit logs](/teams/audit-logs/) - Find who changed what in the organization.
