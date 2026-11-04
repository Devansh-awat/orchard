---
title: Grafts
description: Grafts are Orchard's extensions. A graft adds pages, API endpoints, database tables, MCP tools, and settings to an Orchard instance. Operators install grafts with orchardctl or Helm values.
sidebar:
  order: 1
---

A graft is an extension that adds features to an Orchard instance without a fork. It can add pages, API endpoints, its own database tables, Model Context Protocol (MCP) tools, instance settings, and cards or tabs on existing pages. You find grafts in the [Extension Marketplace](https://orchard.my/extensions). You install them with [`orchardctl graft add`](/grafts/install/) or with Helm values, and Orchard rolls out the change like an upgrade.

:::caution
Only install grafts you trust. A graft runs inside Orchard with the same access as Orchard: your database, your users' data, and your cluster. Orchard checks signatures, versions, and declared requirements, and shows them to you before you install. These checks are not a sandbox.
:::

## Get started

- [Install grafts](/grafts/install/): Add, list, and remove grafts, and set your trust policy.
- [Upgrade and roll back grafts](/grafts/upgrades/): Move between versions and keep your data.
- [Troubleshooting grafts](/grafts/troubleshooting/): Find out why a graft did not load.
- [Build a graft](/grafts/build/quickstart/): Scaffold, run, and sign your own graft.

## Kinds of graft

| Kind      | Publisher                                        | Label in Orchard              |
| --------- | ------------------------------------------------ | ----------------------------- |
| Official  | Orchard                                          | **Official**                  |
| Community | Another author, listed in the Extension Marketplace | **Community · by** the author |
| Tap       | Anyone, from a catalog that you added             | **Tap:** the tap's name       |

Your trust policy controls which kinds can load. For more information, refer to [Trust](/grafts/install/#trust).

Orchard publishes these first-party grafts:

- [Greenhouse](/greenhouse/) (`greenhouse`): Cloud machines with coding agents.
- [The Grove](/run/grove/) (`forum`): A forum for the people on an instance.
- Announcements (`announcements`): Notices on project and app pages.

## Parts of a graft

| Part          | Runs as                                                                        | Location                                                   |
| ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Server module | A NestJS module loaded into the Orchard server                                 | `/apiv1/<graft-id>/...`                                    |
| UI            | An island: a bundle with its own copy of Svelte, mounted in pages Orchard renders | `/<graft-id>/...` and the [slots](/reference/graft-slots/) |
| Migrations    | SQL that Orchard runs in a transaction                                          | The graft's own schema, `ext_<graft_id>`                   |
| MCP tools     | Tools registered in the MCP server                                              | Named `<graft_id>_...`, or claimed by name                 |
| Settings      | Sections in **Instance admin** > **Configuration**                                       | Stored as instance settings                                |
| Cluster chart | An optional Helm chart for CRDs, namespaces, and RBAC                           | Its own Helm release, `orchard-graft-<id>`                 |

## How grafts stay separate from Orchard

- **Doors:** A graft reaches Orchard through versioned interfaces called doors. A stable door does not change shape. A change ships as a new version next to the old one. `orchardctl` refuses a graft that needs a door the instance does not have. For the list, refer to the [graft API reference](/reference/graft-api/).
- **Islands:** A graft's UI carries its own Svelte and its own copy of Orchard's components, and draws in an element that Orchard gives it. Colors and fonts come from the shared theme.
- **Claims:** A graft's names live under its ID, such as `/apiv1/<id>`, `/<id>`, and `<id>.` events. A graft can ask for a name outside its ID with a claim. For more information, refer to [Claims](/grafts/build/manifest/#claims).
- **Data:** Each graft has its own PostgreSQL schema. When the database user can create roles, the graft also has a role that can read only the core columns it declared. Removing a graft keeps its data until you purge it.
- **Failure handling:** Orchard skips a graft that fails to load, migrate, or boot, and shows it as failed in **Instance admin** > **Grafts**. Orchard itself still starts.
