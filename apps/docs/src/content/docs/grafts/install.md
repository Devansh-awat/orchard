---
title: Install grafts
description: Add, list and remove grafts with orchardctl or Helm values, and choose who you trust.
sidebar:
  order: 2
---

Which grafts an instance runs is part of its configuration: a `grafts` list in
the Orchard chart values. `orchardctl graft` edits that list for you on hosts
installed with the [installer](/start/install/); GitOps setups edit it in git.
Either way, changing it rolls Orchard out like an upgrade.

:::caution[Only install grafts you trust]
A graft runs with the same access as Orchard. `orchardctl` shows what a graft
asks for before it installs anything; read it.
:::

## With orchardctl

```sh
sudo orchardctl graft search                 # browse the Extension Marketplace
sudo orchardctl graft info announcements     # versions and what works with your Orchard
sudo orchardctl graft add announcements --apply
```

`add` picks the newest version that works with your Orchard, then, before
changing anything:

1. checks the download against its digest and the signature against your
   [trust policy](#trust)
2. checks the graft against your Orchard version, the doors it uses and the
   grafts it depends on
3. rehearses its database migrations inside a transaction that is rolled back
4. shows you what it asks for: capabilities, core tables it reads, paths outside
   its own and routes open to anyone

Answer yes and the graft is written into your values. `--apply` rolls Orchard
out straight away; without it, run `sudo orchardctl update` when you are ready.

| Command | Does |
| --- | --- |
| `orchardctl graft add <id>[@version]` | Install from the Extension Marketplace |
| `orchardctl graft add ./file.graft` | Install a file. It is stored in Orchard's database, so this works with no internet and on clusters with several nodes |
| `orchardctl graft add https://.../x.graft` | Install from any https address, pinned to the digest it had when you added it |
| `orchardctl graft list` | What is installed, whether it is running, and the latest messages about grafts from the server |
| `orchardctl graft upgrade [id]` | Move to the newest compatible version. See [upgrades](/grafts/upgrades/) |
| `orchardctl graft remove <id>` | Uninstall. The graft's data stays |
| `orchardctl graft remove <id> --purge --apply` | Uninstall and delete its schema, settings and stored files |
| `orchardctl graft rollback <id>` | Go back to the previous version and its data |

Flags: `--yes` skips the prompt, `--dry-run` runs every check and changes
nothing, `--apply` rolls out afterwards.

If a graft ships a cluster chart (for CRDs or RBAC it needs), `add` installs it
as the Helm release `orchard-graft-<id>`. `remove` leaves it in place and prints
the `helm uninstall` command, because other things may depend on what it
installed.

## With Helm values (GitOps)

Add the same entry `orchardctl` would. The Extension Marketplace page for a
graft shows it ready to copy:

```yaml
grafts:
  - id: announcements
    version: 0.2.0
    digest: sha256:1a88f45bf0912a820b1cee27281484a0663966346f85906df7a4c6a6109d4a39

graftSettings:
  trust: signed
```

`digest` is the sha256 of the `.graft` file and is required: a graft is never
installed unless the bytes match. `source` is optional and defaults to the
Extension Marketplace; set it to an `https://` address to install from anywhere
else. A graft with a cluster chart needs that chart installed as its own
HelmRelease.

## Trust

`graftSettings.trust` decides which grafts may load:

| Policy | Loads |
| --- | --- |
| `official` | Only grafts signed by Orchard |
| `signed` (default) | Grafts signed by Orchard or by a publisher key in `graftSettings.keys` |
| `any` | Unsigned grafts too. Anything that ends up in the grafts directory runs |

A publisher gives you their public key (a short base64 string from
`graft keygen`). Add it to trust their grafts:

```sh
sudo orchardctl config set graftSettings.keys '["2Cqg2XC6R3alKo0lU3kUHSQUZz6N8p2DgX2+Ei/bXjY="]' --apply
```

The Extension Marketplace can revoke a version. Revoked versions are never
offered, and `orchardctl` refuses to install one.

## Seeing what is installed

**Admin → Grafts** lists every installed graft with its status, signature, what
it asked for, the core tables it reads, its routes and which of them are open to
anyone. A graft that failed shows the phase it failed in and why. Settings a
graft adds appear under **Admin → Configuration**, labelled with the graft that
added them.

## All the settings

| Value | Environment variable | Default |
| --- | --- | --- |
| `grafts` | `ORCHARD_GRAFTS` | none |
| `graftSettings.trust` | `ORCHARD_GRAFT_TRUST` | `signed` |
| `graftSettings.keys` | `ORCHARD_GRAFT_KEYS` | none |
| `graftSettings.marketplaceUrl` | `ORCHARD_GRAFT_MARKETPLACE_URL` | `https://assets.orchard.my/registry` |
| `graftSettings.strict` | `ORCHARD_GRAFTS_STRICT` | `false`. When true, a graft that fails stops the pod instead of being skipped, so a rollout halts and the previous pods keep serving |
| `graftSettings.safeMode` | `ORCHARD_GRAFTS_SAFE_MODE` | `false`. When true, no grafts load at all. Use it to recover from a graft that misbehaves at runtime |
| | `ORCHARD_GRAFT_DB_POOL` | `3` database connections per graft per pod |

Each graft opens its own small pool of database connections. Many grafts on a
small database can use up its connection limit; Admin → Grafts shows what each
graft holds.
