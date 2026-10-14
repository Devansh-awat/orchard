---
title: The Grove
description: The discussion space for your instance, shipped as the forum graft.
sidebar:
  order: 10
---

The Grove is a forum inside Orchard, for the people using the instance. It exists
so questions and answers live next to the platform they are about, rather than in
a chat history nobody can search.

## Turning it on

The Grove is the `forum` [graft](/grafts/overview/), published to the Extension
Marketplace from the Orchard repository:

```sh
sudo orchardctl graft add forum --apply
```

or, for GitOps, in the Orchard chart values:

```yaml
grafts:
  - id: forum
    version: 1.0.0
    digest: sha256:...
```

Installed means on: `GROVE_ENABLED` and `PUBLIC_GROVE_ENABLED` no longer exist and
are ignored if still set. Image attachments need object storage configured under
**Instance admin**.

### Upgrading from an Orchard that had the Grove built in

When the graft first starts it moves the `forum_*` tables from the `public` schema
into its own `ext_forum` schema in one transaction, without copying or deleting
anything, and leaves views with the old names in `public` so pods still running the
previous release keep working during the rollout. Thread links, numbers and
uploaded images stay where they were. Install the graft in the same change that
upgrades Orchard, or the Grove is unavailable until you do (nothing is lost in
between).

## Threads

Threads are grouped into **categories** and support replies, **votes**, and file
uploads.

Each thread carries a **status**, so a question can be marked resolved and a bug
report can be tracked rather than scrolling away.

## Moderation

Admins can **pin** a thread to keep it at the top, **lock** it to stop further
replies, and set **priority** to surface something important.

Threads and individual replies can be deleted.

## Why it is there

A self-hosted platform tends to grow institutional knowledge: how this cluster is
configured, which base image people use, why that node pool exists. The Grove is
somewhere for that to accumulate where the next person will actually find it.
