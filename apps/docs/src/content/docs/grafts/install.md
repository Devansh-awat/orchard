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

| Command                                        | Does                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `orchardctl graft add <id>[@version]`          | Install from the Extension Marketplace                                                                                |
| `orchardctl graft add ./file.graft`            | Install a file. It is stored in Orchard's database, so this works with no internet and on clusters with several nodes |
| `orchardctl graft add https://.../x.graft`     | Install from any https address, pinned to the digest it had when you added it                                         |
| `orchardctl graft list`                        | What is installed, whether it is running, and the latest messages about grafts from the server                        |
| `orchardctl graft upgrade [id]`                | Move to the newest compatible version. See [upgrades](/grafts/upgrades/)                                              |
| `orchardctl graft remove <id>`                 | Uninstall. The graft's data stays                                                                                     |
| `orchardctl graft remove <id> --purge --apply` | Uninstall and delete its schema, settings and stored files                                                            |
| `orchardctl graft rollback <id>`               | Go back to the previous version and its data                                                                          |

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

## Where grafts come from

Grafts come in three kinds, a bit like Homebrew's core formulae and taps:

| Kind      | Who makes it                                      | How Orchard knows it is real                                                     | Shown as                  |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| Official  | Orchard                                           | Signed with Orchard's key                                                        | Official                  |
| Community | Someone else, listed in the Extension Marketplace | Signed with the author's key, which Orchard vouched for when it listed the graft | Community · by the author |
| Tap       | Anyone, from a tap you added yourself             | Signed with the tap's key, which you trusted when you added the tap              | Tap: its name             |

Community grafts are checked when they are first listed and every new version
passes the same automated checks, but Orchard does not review every update by
hand. Taps are not checked by Orchard at all: adding one means trusting whoever
runs it.

## Trust

`graftSettings.trust` decides which kinds may load:

| Policy             | Loads                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| `official`         | Only Orchard's own grafts                                                            |
| `listed` (default) | Official and community grafts, plus anything signed by a key in `graftSettings.keys` |
| `taps`             | All of the above, plus grafts from taps you added                                    |
| `any`              | Unsigned grafts too. Anything that ends up in the grafts directory runs              |

`signed`, the old name for `listed`, still works.

A publisher can also give you their public key directly (a short base64 string
from `graft keygen`). Add it to trust grafts they share without a tap:

```sh
sudo orchardctl config set graftSettings.keys '["2Cqg2XC6R3alKo0lU3kUHSQUZz6N8p2DgX2+Ei/bXjY="]' --apply
```

The Extension Marketplace can revoke a version or delist a community graft.
Revoked versions are never offered, `orchardctl` refuses to install one, and an
instance that already has it refuses to load it on its next start.

## Taps

A tap is somebody's own catalogue of grafts: a folder of files on any https
host. Add one, then install from it with its name in front:

```sh
sudo orchardctl graft tap add acme https://acme.dev/orchard
sudo orchardctl graft search                 # tap grafts show their tap
sudo orchardctl graft add acme/notes --apply
```

`tap add` shows the tap's signing key and asks you to confirm it. Every graft
from that tap must be signed with that key. Taps only load when
`graftSettings.trust` is `taps` or `any`; set it once:

```sh
sudo orchardctl config set graftSettings.trust taps --apply
```

With Helm values:

```yaml
graftSettings:
  trust: taps
  taps:
    - name: acme
      url: https://acme.dev/orchard
      key: <the key tap add showed you>
grafts:
  - id: notes
    version: 1.2.0
    digest: sha256:...
    tap: acme
```

An instance has one graft per id, whatever the source: installing `acme/notes`
when a `notes` from somewhere else is installed is refused.

## Seeing what is installed

**Admin → Grafts** lists every installed graft with its status, signature, what
it asked for, the core tables it reads, its routes and which of them are open to
anyone. A graft that failed shows the phase it failed in and why. Settings a
graft adds appear under **Admin → Configuration**, labelled with the graft that
added them.

## All the settings

| Value                          | Environment variable            | Default                                                                                                                              |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grafts`                       | `ORCHARD_GRAFTS`                | none                                                                                                                                 |
| `graftSettings.trust`          | `ORCHARD_GRAFT_TRUST`           | `listed`. One of `official`, `listed`, `taps`, `any`                                                                                 |
| `graftSettings.taps`           | `ORCHARD_GRAFT_TAPS`            | none. Taps you added, each with `name`, `url` and `key`                                                                              |
| `graftSettings.keys`           | `ORCHARD_GRAFT_KEYS`            | none                                                                                                                                 |
| `graftSettings.marketplaceUrl` | `ORCHARD_GRAFT_MARKETPLACE_URL` | `https://assets.orchard.my/registry`                                                                                                 |
| `graftSettings.strict`         | `ORCHARD_GRAFTS_STRICT`         | `false`. When true, a graft that fails stops the pod instead of being skipped, so a rollout halts and the previous pods keep serving |
| `graftSettings.safeMode`       | `ORCHARD_GRAFTS_SAFE_MODE`      | `false`. When true, no grafts load at all. Use it to recover from a graft that misbehaves at runtime                                 |
| `graftSettings.pools`          | `ORCHARD_GRAFT_POOLS`           | none. Database connections per pod by graft id, e.g. `{ greenhouse: 15 }`                                                            |
|                                | `ORCHARD_GRAFT_DB_POOL`         | `3` database connections per pod for grafts that ask for no size                                                                     |

## Database connections

Each graft opens its own pool of database connections on every server and
worker pod, next to Orchard's own. A graft asks for a size in its
`graft.json` (Greenhouse asks for 10), and you can change it:

```sh
sudo orchardctl graft pool greenhouse 15 --apply   # or: default
```

Connections are opened only when needed and closed after about ten seconds
idle, so a quiet graft costs almost nothing. The risk is a busy moment: every
pod could open its whole pool at once, and during an update the old and new
server pods run side by side. Orchard adds that up against the database's
`max_connections` at boot and on **Admin → Grafts**. Past 80% it warns; past
100% it says so in red, and with `graftSettings.strict` the new pods refuse to
start so the rollout halts. When the database does run out, new requests fail
until connections free up, so either lower a pool or raise `max_connections`.
