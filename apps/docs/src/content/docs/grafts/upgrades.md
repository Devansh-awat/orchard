---
title: Upgrades and rollback
description: How graft upgrades keep your data safe, and how to go back.
sidebar:
  order: 3
---

Upgrading a graft can change its database, so Orchard is careful about it.
Everything here only ever touches the graft's own schema, `ext_<graft_id>`.
Orchard's own data is never part of a graft upgrade or rollback.

## What happens on an upgrade

```sh
sudo orchardctl graft upgrade announcements --apply
```

1. **Rehearsal.** The new version's migrations run against your live database
   inside a transaction that is then rolled back. If they would fail, you see the
   exact error and nothing changes. `--dry-run` stops here.
2. **Snapshot.** The graft's schema and its migration history are saved under
   `/etc/orchard/graft-snapshots/<id>/<time>/`. The last five are kept.
3. **Rollout.** The new version is written into your values and Orchard rolls
   out. The first pod to start runs the migrations, all of them in one
   transaction: either every one applies or none do. If they fail, that pod
   reports the graft as failed and the rest of Orchard keeps running.

Migrations that cannot run in a transaction, such as
`CREATE INDEX CONCURRENTLY`, are marked by their author and run on their own.
`graft doctor` warns about them, and a dry run cannot rehearse them.

While a rollout is in progress, old and new pods run side by side for a short
time. Graft authors write migrations that both versions can live with (add a
column first, stop using an old one a version later), the same rule Orchard
follows for its own.

## Rolling back

```sh
sudo orchardctl graft rollback announcements --apply
```

Rollback puts the previous version back into your values and restores the
snapshot taken before the upgrade. **Anything the graft saved after the upgrade
is lost**, which is why the command makes you type the graft's id to confirm.
Orchard's own data, and every other graft's, is untouched.

If you upgraded through Helm values rather than `orchardctl`, there is no
snapshot. Set the previous version back in your values; if the newer version's
migrations already ran, the older version refuses to start until its data is
restored from your own backup, rather than running against a schema it does not
understand.

## Edited migrations are refused

Orchard records a checksum for every migration it applies. A graft version
whose already-applied migration has changed is refused, so a republished graft
cannot quietly rewrite history. Authors ship a new migration instead.

## Following a version range from Git

Values always pin an exact version and digest, so every pod runs the same graft
and a revert is a rollback. To keep a pin moving without editing it by hand, mark
the version with a range:

```yaml
grafts:
  - id: greenhouse
    version: 1.2.0 # {"$graftpolicy": "^1"}
    digest: sha256:...
```

and run `graft bump` from the graft SDK in your GitOps repository:

```sh
npx -p @orchardlabs/graft-sdk graft bump values.yaml --platform 2.70.0
```

It moves each marked graft to the newest signed, unrevoked marketplace version
inside its range and rewrites the digest with it. It never downgrades, and with
`--platform` set to the Orchard version you run it holds back any release whose
`engines.platform` that version does not satisfy, printing `held` instead, so a
graft never lands on a server too old to load it. `--check` reports without
writing and exits 2 when something would change.

Run it when a graft is published and again when your Orchard version changes,
then commit the result. Upgrades made this way go through Helm values, so the
rehearsal and snapshot above do not apply.
