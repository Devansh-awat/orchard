---
title: Run the Grove
description: Turn on the Grove, a discussion forum for the people on your Orchard instance, shipped as the forum graft.
sidebar:
  order: 10
---

The Grove is a forum for the people on an Orchard instance. It holds bug reports and feature requests, with votes, replies, and image attachments. It ships as the `forum` [graft](/grafts/overview/).

## Turn on the Grove

Installing the graft turns on the Grove. On an installer host, run the following command:

```sh
sudo orchardctl graft add forum --apply
```

On a GitOps setup, add the graft to the chart values:

```yaml
grafts:
  - id: forum
    version: <version>
    digest: sha256:...
```

`GROVE_ENABLED` and `PUBLIC_GROVE_ENABLED` no longer exist. Orchard ignores them if they are set.

Image attachments need object storage. To set it up, go to **Instance admin** > **Configuration** > **Object storage**.

## Upgrade from a built-in Grove

If an earlier Orchard release had the Grove built in, install the graft in the same change that upgrades Orchard. Until you install it, the Grove is unavailable. No data is lost in that period.

When the graft first starts, it moves the `forum_*` tables from the `public` schema to the `ext_forum` schema in one transaction. It does not copy or delete anything. It leaves views with the old names in `public`, so pods on the previous release keep working during the rollout. Thread links, numbers, and uploaded images stay the same.

## Moderate threads

Superadmins can manage threads with these actions:

| Action       | Result                                     |
| ------------ | ------------------------------------------ |
| Set status   | Tracks where a report or a request stands. |
| Set priority | Marks how important a thread is.           |
| Pin          | Keeps a thread at the top.                 |
| Lock         | Stops further replies.                     |
| Delete       | Removes a thread or a reply.               |

## Related resources

- [Install grafts](/grafts/install/)
