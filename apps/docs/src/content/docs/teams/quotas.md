---
title: Quotas and usage
description: Set Orchard organization caps and member allowances, read the Usage page, and transfer project ownership.
sidebar:
  order: 5
---

To stop one person or project from using all of a cluster's capacity, set quotas. This page explains how Orchard calculates limits and how to change them.

## How limits apply

Orchard checks three limits when an app or database is created, scaled or resized:

1. The organization cap, set by a superadmin.
2. The project cap, if the project has its own. A project cap replaces the organization cap for that project.
3. The member allowance of the project owner.

Quotas count the CPU and memory that you select for an app. The resource picker shows the remaining budget while you size an app.

A member with no allowance of their own uses the organization's default allowance. If the organization has no default, the member has no limit.

## Set an organization cap

You must be a superadmin.

1. Go to **Instance admin** > **Organizations**.
2. Select **Resource quotas** on the organization row.
3. Enter **CPU (millicores)**, **Memory (MiB)**, **Max pods** and **Max services**.
4. Save the quotas.

Orchard applies the quotas to the cluster when you save.

## Set a member allowance

You must be an organization owner or admin.

1. In your organization, go to **Usage** > **Members**.
2. To set the default, select **Edit** in **Default allowance**.
3. To set one person's allowance, select the edit control on their row.

## Read usage

Go to **Usage** in your organization. Owners and admins see all of the following tabs. Other members see **Yours**.

| Tab              | Shows                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| **Organization** | Capacity against caps, and usage by project.                           |
| **Yours**        | The workloads that you own.                                            |
| **Members**      | The default allowance, and each member's usage against their allowance. |
| **Right-sizing** | How workloads compare with their allocated resources.                  |

Size apps from metrics over a time range rather than a single reading, so that the size covers the peak you care about.

## Transfer project ownership

Every project has an owner, who is the person who created it unless ownership has moved. All apps and databases in the project count against the owner's allowance.

The project owner, or an organization owner or admin, can start a transfer. The new owner must already be a member of the project.

To start a transfer from the dashboard:

1. Go to the project **Settings** tab.
2. In **Danger zone**, select **Transfer** next to **Transfer ownership**.
3. In **New owner**, select the person.
4. Select **Send request**.

To start a transfer from the CLI:

```bash
orchard project transfer request someone@example.com
```

The recipient accepts or declines the request. The request expires after seven days. To list and accept requests from the CLI, run the following commands:

```bash
orchard project transfer list
orchard project transfer accept <REQUEST_ID>
```

Orchard rejects the transfer if the project does not fit in the new owner's allowance. To continue, raise the allowance or reduce the project.

When the recipient accepts, they become a project admin. The previous owner keeps their current project role.

## Related resources

- [Scaling and resources](/deploy/scaling/)
- [Nodes and pools](/operate/nodes/)
