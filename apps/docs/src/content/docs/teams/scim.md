---
title: Set up SCIM provisioning
description: Connect an identity provider to Orchard with SCIM 2.0 to add, update, and deactivate organization members automatically.
sidebar:
  order: 3
---

To add and remove organization members from your identity provider, connect the provider to Orchard with System for Cross-domain Identity Management (SCIM) 2.0. SCIM manages membership. It does not sign anyone in. To sign in through the provider, also [set up SSO](/teams/sso/).

## Prerequisites

- The **Owner** [role](/teams/organizations/#organization-roles) in the organization. Only owners can open the SCIM tab or manage SCIM tokens.

## Connect your identity provider

1. Go to **Organization settings** > **SCIM**.
2. Copy the **Endpoint** value.
3. In **Tokens**, select **New token**.
4. Enter a **Name**, such as `Okta production`.
5. Select **Generate token**.
6. Copy the token. Orchard does not show it again.
7. In your identity provider's SCIM 2.0 connector, enter the endpoint and token.
8. Run a test sync with one user before you turn on the whole directory.

By default, the endpoint is `/apiv1/scim/v2` on the host that serves your instance. To publish another address, set `SCIM_BASE_URL` on the server. The token decides which organization a request applies to, so all organizations share one endpoint.

To revoke a token, select **Revoke** on its row. Requests that use the token fail with a `401` status.

## What SCIM changes

| Provider action       | Result in Orchard                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Create a user         | Adds the person to the organization. The default role is **Member**.                                               |
| Update a user         | Updates the attributes that SCIM owns on the membership. A `PUT` request that omits an attribute clears it.        |
| Set `active` to false | Removes the membership. Orchard keeps the SCIM record, so the provider can reactivate the person with the same ID. |
| Delete a user         | Removes the membership and the SCIM record.                                                                        |

SCIM only changes the membership in this organization. It cannot delete the person's Orchard account, change their profile, or affect their other organizations. Deactivating or deleting a user signs out their SSO sessions and deletes their API tokens for this organization.

SCIM can add anyone's email address, including people outside your verified domains. Orchard emails the person to say which organization added them, and they can [leave the organization](/teams/organizations/#leave-an-organization) unless it manages their domain.

Orchard refuses to deactivate, delete, or demote the last owner of an organization.

## Assign roles from your provider

Orchard reads a member's role from the SCIM `roles` attribute or the `userType` attribute. The accepted values are `admin`, `member`, and `guest`. A provider cannot grant `owner`, including by reactivating a user who used to be one: a reactivated member keeps the role they hold now, and a deactivated owner with no current membership comes back as `admin`.

A role sent by the provider overrides a change made in the dashboard at the next sync.

If the organization's SSO connection has [group rules](/teams/sso/#map-provider-groups-to-roles), the rules decide a person's role at each sign-in and override the SCIM role.

## Push groups from your provider

Your provider can push groups to the **Groups** endpoint. Orchard stores each group's name and members as a directory. A group has no role of its own. It counts only when an [SSO group rule](/teams/sso/#map-provider-groups-to-roles) names it, and then it works like a group claim at sign-in.

When a push creates a group, renames it, changes its members, or deletes it, Orchard re-evaluates the people it touched against the connection's rules:

- A person who gains a matching group gets the rule's role. A person who matches several rules gets the highest.
- A person whose last matching group goes away loses the membership that rules gave them, and Orchard signs out their SSO sessions and deletes their API tokens for this organization. Memberships you added by hand are not removed.
- A group never creates a membership. Add the person with a user push first. A deactivated user stays in the group but gets no access until reactivated.
- Rules never give **Owner**, and a rule never changes an owner.
- At sign-in, Orchard combines the groups in the sign-in with the groups the directory holds for that person.

Only the token's organization is affected. A token cannot read, change, or delete another organization's groups, or add its people to a group. Group names must be 1 to 256 characters, an organization can hold up to 1,000 groups, and a group up to 10,000 members.

The four built-in groups (`Owner`, `Admin`, `Member`, `Guest`, with IDs such as `role:admin`) remain a read-only view of roles. Requests that change them return a `400` status.

Deactivating or deleting a user signs out their SSO sessions and deletes their API tokens for this organization, not only their membership.

Orchard records `scim.group.created`, `scim.group.updated`, and `scim.group.deleted` entries in the [audit log](/teams/audit-logs/).

## Provision accounts for the whole instance

To provision accounts from a company directory, a superadmin creates an instance SCIM token at **Instance admin** > **Sign in**. Point your provider's SCIM connector at `https://<your-host>/apiv1/scim/instance/v2`.

The connector creates accounts, renames them, and turns them off. Instance rules decide which organizations people join when they sign in. Organization tokens do not work on this endpoint, and instance tokens do not work on an organization's endpoint.

## Related resources

- [Set up SSO](/teams/sso/)
- [Manage organizations and roles](/teams/organizations/)
