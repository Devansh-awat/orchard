---
title: Grafts
description: Grafts are Orchard's extensions. What they can add, how they run, and what installing one means.
sidebar:
  order: 1
---

Grafts are Orchard's extensions. A graft adds something to your Orchard instance
without forking it: new pages, new API endpoints, its own database tables, MCP
tools for agents, settings in the admin panel, and cards or tabs on the pages you
already use. The name comes from orcharding, where a graft joins a new branch onto
an existing tree.

Grafts are found in the [Extension Marketplace](https://orchard.my/extensions),
installed with [`orchardctl graft add`](/grafts/install/) or your Helm values, and
rolled out the same way an Orchard upgrade is, with no downtime.

:::caution[Only install grafts you trust]
A graft runs inside Orchard with the same access Orchard has: your database,
your users' data and your cluster. Orchard checks signatures, versions and what
a graft says it needs, and shows you all of it before you install, but none of
that is a sandbox. Install a graft only if you would be happy running its code as
Orchard itself.
:::

## Official, community and taps

Orchard makes some grafts itself (**Official**). Other people can list theirs in
the [Extension Marketplace](https://orchard.my/extensions) (**Community**, with the
author's name on it), or run their own catalogue that you add by hand (a
**tap**). Each kind is labelled everywhere it appears, and your trust setting
decides which kinds may load. See [Where grafts come from](/grafts/install/#where-grafts-come-from).

## What a graft is made of

| Part          | Runs as                                                                             | Lives at                                                   |
| ------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Server module | A NestJS module loaded into the Orchard server                                      | `/apiv1/<graft-id>/...`                                    |
| UI            | An island: a bundle with its own copy of Svelte, mounted into pages Orchard renders | `/<graft-id>/...` and the [slots](/reference/graft-slots/) |
| Migrations    | SQL run by Orchard in a transaction                                                 | The graft's own schema, `ext_<graft_id>`                   |
| MCP tools     | Tools registered in the MCP server                                                  | Named `<graft_id>_...`                                     |
| Settings      | Sections on Admin → Configuration                                                   | Stored like any other instance setting                     |
| Cluster chart | An optional Helm chart for CRDs, namespaces and RBAC                                | Its own Helm release, `orchard-graft-<id>`                 |

## How grafts stay out of Orchard's way

**Doors.** A graft talks to Orchard through a small set of versioned doors, such
as `auth@1` for permission checks and `db@1` for its own database connection. A
door never changes shape once it is stable; a change ships as a new version next
to the old one. The [graft API reference](/reference/graft-api/) lists every
door, and Orchard refuses to install a graft that needs a door it does not have.

**Islands.** A graft's UI carries its own Svelte and its own copy of Orchard's
components, and draws into an empty box Orchard gives it. Orchard upgrading its
own UI can never break a graft. Colours and fonts come from the shared theme, so
grafts look like the rest of Orchard.

**Claims.** Everything a graft names lives under its id: `/apiv1/<id>`, `/<id>`,
`<id>.` events and settings. A graft can ask for a name outside that, such as a
shorter URL, but core Orchard always wins a conflict: if Orchard later ships the
same path, the graft keeps working under its own id and the admin page shows the
older path as taken.

**Its own data.** Each graft gets a Postgres schema of its own and, when the
database allows it, a role that can only read the core columns the graft
declared. Removing a graft keeps its data until you purge it.

**Containment.** A graft that fails to load, migrate or boot is skipped and shown
as failed on Admin → Grafts. Orchard itself still starts.

## Where to go next

- [Install a graft](/grafts/install/)
- [Upgrades and rollback](/grafts/upgrades/)
- [Build a graft](/grafts/build/quickstart/)
