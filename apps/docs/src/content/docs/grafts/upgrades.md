---
title: Upgrade and roll back grafts
description: Upgrade an Orchard graft with a rehearsal and a snapshot, roll back to the previous version and its data, and follow a version range from Git.
sidebar:
  order: 3
---

You can move a graft to a new version or return to the previous one. An upgrade or rollback changes only the graft's own schema, `ext_<graft_id>`. It does not change Orchard's data or the data of other grafts.

## Upgrade a graft

Run the following command:

```sh
sudo orchardctl graft upgrade announcements --apply
```

To upgrade all grafts, omit the ID. A graft that you installed from a file does not upgrade this way. Run `orchardctl graft add` with the newer file.

The command does the following:

1. **Rehearsal:** It runs the new version's migrations against your live database, in a transaction that it rolls back. If they would fail, it shows the error and changes nothing. `--dry-run` stops here.
2. **Snapshot:** If the new version has pending migrations, it saves the graft's schema and migration history under `/etc/orchard/graft-snapshots/<id>/<time>/`. It keeps the last five snapshots.
3. **Rollout:** It writes the new version to your values, and Orchard rolls out. The first pod to start runs the pending migrations in one transaction. If they fail, that pod reports the graft as failed and the rest of Orchard keeps running.

:::note
`orchardctl` cannot take a snapshot when Orchard uses an external database. Back up the database yourself and pass `--no-snapshot`.
:::

An author can mark a migration that cannot run in a transaction, such as `CREATE INDEX CONCURRENTLY`. These migrations run on their own, and `--dry-run` cannot rehearse them. [`graft doctor`](/grafts/build/quickstart/#3-check-pack-and-sign) warns about them.

During a rollout, old and new pods run side by side for a short time.

## Roll back a graft

Run the following command:

```sh
sudo orchardctl graft rollback announcements --apply
```

The command puts the previous version back in your values and restores the snapshot taken before the upgrade.

:::caution
Anything the graft saved after the upgrade is lost. The command asks you to type the graft's ID to confirm.
:::

### Roll back an upgrade made with Helm values

Upgrades made through Helm values have no snapshot. Set the previous version back in your values.

If the newer version's migrations already ran, the older version fails in the `migrations` phase, with this message:

```text
applied migrations are missing from this version: 0002_pinned; downgrades must use orchardctl graft rollback
```

Restore the graft's schema from your own backup.

## Edited migrations

Orchard records a checksum for each migration it applies. It refuses a graft version whose applied migration has changed. Authors ship a new migration instead.

## Follow a version range from Git

Values pin an exact version and digest, so that every pod runs the same graft. To update a pin automatically, mark the version with a range:

```yaml
grafts:
  - id: greenhouse
    version: 1.2.0 # {"$graftpolicy": "^1"}
    digest: sha256:<digest>
```

In your GitOps repository, run `graft bump` from the graft SDK:

```sh
npx -p @orchardlabs/graft-sdk graft bump values.yaml --platform 2.70.0
```

The command moves each marked graft to the newest signed, unrevoked Extension Marketplace version in its range, and rewrites the digest. It does not downgrade.

| Flag                   | Effect                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `--platform <version>` | Holds back a release whose `engines.platform` does not include this Orchard version, and prints `held`. |
| `--marketplace <url>`  | Reads from another marketplace.                                                                         |
| `--check`              | Reports without writing. Exits with code 2 when something would change.                                 |

Run the command when a graft is published and when your Orchard version changes, then commit the result. These upgrades go through Helm values, so the rehearsal and snapshot do not apply.

## Related resources

- [Install grafts](/grafts/install/)
- [Troubleshooting grafts](/grafts/troubleshooting/)
- [Grafts](/grafts/overview/)
- [Upgrade Orchard](/operate/upgrades/)
