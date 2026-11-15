---
title: Read audit logs
description: Read Orchard audit logs at the app, organization, and instance level to find who made a change and when.
sidebar:
  order: 4
---

When something changes and you need to know who did it, read the audit log. Orchard records actions taken through Orchard, such as deploys, deletions, member and role changes, settings changes, and database operations. Each entry has the actor, the action, the target, and the time.

Orchard keeps audit log entries for 180 days and then deletes them. You cannot edit entries from the dashboard.

## View audit logs

| Level        | Who can read it                 | Location                                  |
| ------------ | ------------------------------- | ----------------------------------------- |
| App          | Anyone who can view the project | The **History** tab of the app            |
| Organization | Owners and admins               | **Organization settings** > **Audit log** |
| Instance     | Superadmins                     | **Instance admin** > **Audit log**        |

To read an organization's audit log from a terminal, run the following command:

```bash
orchard audit list
```

For flags and pagination, refer to the [`orchard audit` reference](/reference/cli/#audit).

## Limitations

Audit logs do not record actions taken outside Orchard. A person who uses `kubectl` directly on the cluster does not appear in the log. Keep cluster credentials more restricted than Orchard accounts.

## Related resources

- [Manage organizations and roles](/teams/organizations/) - Decide who can take the actions the log records.
- [Security and isolation](/operate/security/) - Learn what Orchard protects and what it leaves to the cluster.
