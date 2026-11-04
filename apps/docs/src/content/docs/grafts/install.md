---
title: Install grafts
description: Add, list, and remove Orchard grafts with orchardctl or Helm values, and set the trust policy that controls which grafts can load.
sidebar:
  order: 2
---

To add a graft to your instance, install it with `orchardctl` or Helm values. The list of grafts is part of the instance's configuration: a `grafts` list in the Orchard chart values. `orchardctl graft` edits that list on hosts set up by the [installer](/start/install/). GitOps setups edit it in Git. In both cases, a change rolls Orchard out like an upgrade.

:::caution
Only install grafts you trust. A graft runs with the same access as Orchard. `orchardctl` shows what a graft asks for before it installs anything.
:::

## Install with orchardctl

1. Find a graft:

   ```sh
   sudo orchardctl graft search
   ```

2. Review its versions, and which of them work with your instance:

   ```sh
   sudo orchardctl graft info announcements
   ```

3. Add the graft:

   ```sh
   sudo orchardctl graft add announcements --apply
   ```

`add` selects the newest version that works with your Orchard, unless you give a version with `<id>@<version>`. It then runs these checks on the server:

1. It checks the download against its digest, and the signature against your [trust policy](#trust).
2. It checks the graft against your Orchard version, the doors it uses, and the grafts it depends on.
3. It rehearses the database migrations inside a transaction, then rolls them back.

`orchardctl` then shows the graft's capabilities, the core tables it reads, its paths outside its own ID, and its routes open to anyone. It also checks that any CRDs the graft requires exist.

After you confirm, `orchardctl` writes the graft into your values. `--apply` rolls Orchard out immediately. Without it, run `sudo orchardctl update` when you are ready.

### Commands

| Command                                        | Action                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `orchardctl graft search [term]`               | Searches the Extension Marketplace and your taps.                                                             |
| `orchardctl graft info <id>`                   | Shows a graft's tier, publisher, versions, and compatibility.                                                 |
| `orchardctl graft add <id>[@version]`          | Installs from the Extension Marketplace.                                                                      |
| `orchardctl graft add ./file.graft`            | Installs a file. Orchard stores it in its database, so this works offline and on clusters with several nodes. |
| `orchardctl graft add https://.../x.graft`     | Installs from an `https` address, pinned to the digest it had when you added it.                              |
| `orchardctl graft list`                        | Shows what is installed, whether it is running, and recent server messages about grafts.                      |
| `orchardctl graft upgrade [id]`                | Moves to the newest compatible version. Refer to [Upgrade and roll back grafts](/grafts/upgrades/).           |
| `orchardctl graft rollback <id>`               | Returns to the previous version and its data.                                                                 |
| `orchardctl graft remove <id>`                 | Uninstalls the graft. Its data stays.                                                                         |
| `orchardctl graft remove <id> --purge --apply` | Uninstalls the graft and deletes its schema, stored files, and settings.                                      |
| `orchardctl graft pool <id> [n\|default]`      | Shows or sets the database connections the graft can open per pod.                                            |
| `orchardctl graft tap add\|list\|remove`       | Manages [taps](#add-a-tap).                                                                                   |
| `orchardctl graft trust [level]`               | Shows or sets the [trust policy](#trust).                                                                     |

`add` and `upgrade` accept these flags:

| Flag        | Effect                                |
| ----------- | ------------------------------------- |
| `--yes`     | Skips the confirmation prompt.        |
| `--dry-run` | Runs every check and changes nothing. |
| `--apply`   | Rolls Orchard out afterward.          |

If a graft includes a cluster chart for CRDs or RBAC, `add` installs it as the Helm release `orchard-graft-<id>`. `remove` leaves that release in place and prints the `helm uninstall` command.

## Install with Helm values

Add an entry to your values. The graft's [Extension Marketplace](https://orchard.my/extensions) page shows the entry to copy.

```yaml
grafts:
  - id: announcements
    version: <version>
    digest: sha256:<digest>

graftSettings:
  trust: listed
```

`digest` is the SHA-256 of the `.graft` file. It is required, and Orchard does not install a graft whose bytes do not match. `source` is optional and defaults to the Extension Marketplace. Set it to an `https://` address to install from elsewhere.

A graft with a cluster chart needs that chart installed as its own HelmRelease.

## Where grafts come from

| Kind      | Publisher                                           | How Orchard identifies it                                           | Label                         |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------- |
| Official  | Orchard                                             | Signed with Orchard's key                                           | **Official**                  |
| Community | Another author, listed in the Extension Marketplace | Signed with the author's key, from a listing that Orchard signed    | **Community · by** the author |
| Tap       | Anyone, from a tap you added                        | Signed with the tap's key, which you trusted when you added the tap | **Tap:** its name             |

An Orchard maintainer reviews a community graft when it is first listed. Each new version passes automated checks, but no one reviews it by hand. Orchard does not check taps.

## Trust

`graftSettings.trust` controls which grafts can load:

| Policy             | Loads                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| `official`         | Only Orchard's own grafts                                                         |
| `listed` (default) | Official and community grafts, and grafts signed by a key in `graftSettings.keys` |
| `taps`             | All of the above, and grafts from taps you added                                  |
| `any`              | Unsigned grafts too. Anything in the grafts directory runs.                       |

`signed` is an older name for `listed`, and it still works.

To change the policy, run the following command:

```sh
sudo orchardctl graft trust taps --apply
```

A publisher can also give you a public key, a short base64 string from `graft keygen`. To trust grafts signed with it, run `sudo orchardctl config edit` and add the key to `graftSettings.keys`.

The Extension Marketplace can revoke a version or delist a community graft. `orchardctl` does not offer or install a revoked version. An instance that has it refuses to load it on its next start.

## Add a tap

A tap is a catalog of grafts in a folder on an `https` host.

1. Add the tap. The command shows the tap's signing key and asks you to confirm it.

   ```sh
   sudo orchardctl graft tap add acme https://acme.dev/orchard
   ```

2. Allow taps in your trust policy:

   ```sh
   sudo orchardctl graft trust taps --apply
   ```

3. Install a graft with the tap's name in front:

   ```sh
   sudo orchardctl graft add acme/notes --apply
   ```

Every graft from a tap must be signed with the tap's key.

With Helm values:

```yaml
graftSettings:
  trust: taps
  taps:
    - name: acme
      url: https://acme.dev/orchard
      key: <the key that tap add showed>
grafts:
  - id: notes
    version: <version>
    digest: sha256:<digest>
    tap: acme
```

An instance has one graft per ID, whatever its source. `orchardctl` refuses `acme/notes` if a `notes` graft from another source is installed.

## View installed grafts

Go to **Instance admin** > **Grafts**. The page lists each graft with its status, signature, capabilities, core table reads, and routes, including routes open to anyone. A failed graft shows the phase it failed in and the reason. Settings that a graft adds appear in **Instance admin** > **Configuration**.

## Settings

| Value                          | Environment variable            | Default                                                                                                                              |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grafts`                       | `ORCHARD_GRAFTS`                | None                                                                                                                                 |
| `graftSettings.trust`          | `ORCHARD_GRAFT_TRUST`           | `listed`. One of `official`, `listed`, `taps`, or `any`.                                                                             |
| `graftSettings.taps`           | `ORCHARD_GRAFT_TAPS`            | None. Each tap has a `name`, `url`, and `key`.                                                                                       |
| `graftSettings.keys`           | `ORCHARD_GRAFT_KEYS`            | None                                                                                                                                 |
| `graftSettings.marketplaceUrl` | `ORCHARD_GRAFT_MARKETPLACE_URL` | `https://assets.orchard.my/registry`                                                                                                 |
| `graftSettings.strict`         | `ORCHARD_GRAFTS_STRICT`         | `false`. When true, a graft that fails stops the pod instead of being skipped. The rollout halts and the previous pods keep serving. |
| `graftSettings.safeMode`       | `ORCHARD_GRAFTS_SAFE_MODE`      | `false`. When true, no grafts load.                                                                                                  |
| `graftSettings.pools`          | `ORCHARD_GRAFT_POOLS`           | None. Database connections per pod by graft ID, for example `{ greenhouse: 15 }`.                                                    |
|                                | `ORCHARD_GRAFT_DB_POOL`         | `3`. Database connections per pod for grafts that do not ask for a size.                                                             |

## Database connections

Each graft opens its own pool of database connections on every server and worker pod. A graft asks for a size in its `graft.json`. Greenhouse asks for 10. To change a graft's size, run the following command:

```sh
sudo orchardctl graft pool greenhouse 15 --apply
```

To return to the size the graft asks for, use `default` instead of a number.

Connections open when needed and close after about 10 seconds idle. Every pod can open its whole pool at once, and during an update the old and new server pods run side by side.

Orchard compares this peak against the database's `max_connections` at boot and in **Instance admin** > **Grafts**:

- Past 80% of usable connections, Orchard warns.
- Past 100%, Orchard reports that the budget is exceeded. With `graftSettings.strict`, new pods refuse to start and the rollout halts.

When the database runs out of connections, new requests fail until connections free up. Lower a pool or raise `max_connections`.

## Related resources

- [Upgrade and roll back grafts](/grafts/upgrades/)
- [Graft API versions](/reference/graft-api/)
- [Run Greenhouse](/operate/greenhouse/)
