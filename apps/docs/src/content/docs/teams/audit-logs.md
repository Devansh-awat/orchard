---
title: Audit logs
description: Read Orchard audit logs at the app, organization and instance level to find who made a change and when.
sidebar:
  order: 4
---

Orchard audit logs record actions taken through Orchard, such as deploys, deletions, member and role changes, settings changes and database operations. Each entry has the actor, the action, the target and the time.

Orchard keeps audit log entries for 180 days and then deletes them. You cannot edit entries from the dashboard.

## View audit logs

| Level        | Who can read it                 | Location                                                     |
| ------------ | ------------------------------- | ------------------------------------------------------------ |
| App          | Anyone who can view the project | The **History** tab of the app                               |
| Organization | Owners and admins               | **Settings** > **Audit log**                                 |
| Instance     | Superadmins                     | **Instance admin** > **Audit log**                           |

To read an organization's audit log from a terminal, run the following command:

```bash
orchard audit list
```

For flags and pagination, refer to the [CLI reference](/reference/cli/).

## Limitations

Audit logs do not record actions taken outside Orchard. A person who uses `kubectl` directly on the cluster does not appear in the log. Keep cluster credentials more restricted than Orchard accounts.

## Related resources

- [Manage organizations and roles](/teams/organizations/)
- [Security and isolation](/operate/security/)
