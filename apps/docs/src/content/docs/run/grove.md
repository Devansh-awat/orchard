---
title: Run the Grove
description: Turn on the Grove, a discussion forum for the people on your Orchard instance, shipped as the forum graft.
sidebar:
  order: 10
---

The Grove gives the people on your Orchard instance one place to report bugs and request features. People vote on threads, reply, and attach images, and superadmins set the status and priority of each thread. The Grove ships as the `forum` [graft](/grafts/overview/), so you install it only if you want it.

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

Orchard does not read an environment variable for the Grove. The graft is the only switch.

Image attachments need [object storage](/operate/storage/). To set it up, go to **Instance admin** > **Configuration** > **Object storage**.

## Upgrade from a built-in Grove

If an earlier Orchard release had the Grove built in, install the graft in the same change that [upgrades Orchard](/operate/upgrades/). Until you install it, the Grove is unavailable. No data is lost in that period.

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

- [Install grafts](/grafts/install/) - Install grafts with `orchardctl` or Helm values, and add taps.
- [Post announcements](/grafts/announcements/) - Post notices on project and app overview pages with the `announcements` graft.
