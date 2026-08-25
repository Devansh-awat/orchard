---
title: Audit logs
description: A record of who did what.
sidebar:
  order: 4
---

Audit logs record actions taken in an organization: deploys, deletions, member
and role changes, settings changes, database operations. Each entry has the
actor, the action, the target and the time.

They are readable at three levels:

| Level        | Shows                                          |
| ------------ | ---------------------------------------------- |
| Deployment   | Everything that happened to one app            |
| Organization | Everything across the organization, for admins |
| Instance     | Everything, for superadmins                    |

## What they are for

Answering "when did this change and who changed it" without reconstructing it
from memory. The most common real use is not compliance: it is working out which
change preceded the thing that broke.

## Notes

Audit logs are append-only and are not editable from the dashboard.

They record actions taken **through Orchard**. Someone with direct `kubectl`
access to the cluster is outside this record, which is a reason to keep cluster
credentials narrower than Orchard accounts.
