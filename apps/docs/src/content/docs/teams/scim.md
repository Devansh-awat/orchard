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

SCIM only changes the membership in this organization. It cannot delete the person's Orchard account, change their profile, sign them out, or affect their other organizations.

SCIM can add anyone's email address, including people outside your verified domains. Orchard emails the person to say which organization added them, and they can [leave the organization](/teams/organizations/#leave-an-organization) unless it manages their domain.

Orchard refuses to deactivate, delete, or demote the last owner of an organization.

## Assign roles from your provider

Orchard reads a member's role from the SCIM `roles` attribute or the `userType` attribute. The accepted values are `admin`, `member`, and `guest`. A provider cannot grant `owner`, including by reactivating a user who used to be one: a reactivated member keeps the role they hold now, and a deactivated owner with no current membership comes back as `admin`.

A role sent by the provider overrides a change made in the dashboard at the next sync.

SCIM Groups in Orchard are a read-only view of organization roles. Requests that create or change a group return a `501` status. Map roles with `roles` or `userType` instead.

## Related resources

- [Set up SSO](/teams/sso/)
- [Manage organizations and roles](/teams/organizations/)
