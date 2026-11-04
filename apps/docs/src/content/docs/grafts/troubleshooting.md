---
title: Troubleshooting grafts
description: Fix common Orchard graft failures by symptom, including failed downloads, signature errors, version conflicts, and failed migrations, and recover an instance with safe mode.
sidebar:
  order: 4
---

Use this page to fix common failures with grafts. Each entry lists the symptom, the cause, and the fix.

**Instance admin** > **Grafts** shows each graft's status. A failed graft shows **Failed during** a phase, and the reason. `sudo orchardctl graft list` shows the status too, with recent server messages about grafts.

## Failure phases

| Phase          | Meaning                                                                                                 | Fix                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `sync`         | The download failed, the digest did not match, or the signature did not pass your trust policy.         | Check `digest` in your values and your [trust policy](/grafts/install/#trust). |
| `manifest`     | `graft.json` is invalid.                                                                                 | Ask the publisher for a fixed version.                                        |
| `integrity`    | A file does not match the signed file list, or the signature does not pass your trust policy.            | Reinstall. Do not edit files in an installed graft.                           |
| `compat`       | The graft needs a different Orchard version, graft SDK, or door.                                         | Upgrade Orchard, or install a matching version of the graft.                  |
| `dependencies` | A graft it needs is missing, failed, or the wrong version.                                               | Install or fix the other graft first.                                         |
| `migrations`   | Its database changes failed and were rolled back.                                                        | Read the error. It is usually a bug in the graft.                             |
| `load`         | Its server code threw an error while loading.                                                            | Contact the publisher.                                                        |
| `routes`       | Its routes do not match what it was packed with, or it opens a route to anyone without declaring it.     | Contact the publisher, or reinstall if a file changed.                        |
| `boot`         | Orchard could not start with the graft, and started without it.                                          | Read the reason. A common cause is a capability missing from `graft.json`.    |

## digest mismatch

```text
digest mismatch: expected 1a88f45b..., downloaded 7c2d91e0...
```

**Cause:** The file at the source is not the file your values pin.

**Fix:** Check `digest` in your values. If the publisher changed the file at that address, ask for a new version.

## MANIFEST.sig does not verify against any trusted key

```text
MANIFEST.sig does not verify against any trusted key
```

**Cause:** The graft is signed with a key that your instance does not trust.

**Fix:** Add the publisher's key to `graftSettings.keys`, or install the graft from its listing or tap.

## graft is unsigned

```text
graft is unsigned and the trust policy is "listed"; add its publisher key or set the policy to "any"
```

**Cause:** The graft has no signature.

**Fix:** Ask the publisher for a signed version. Setting the policy to `any` lets any file in the grafts directory run.

## was revoked by the Extension Marketplace

```text
notes 1.2.0 (sha256:1a88f45b...) was revoked by the Extension Marketplace; install another version
```

**Cause:** The Extension Marketplace revoked this version.

**Fix:** Run `sudo orchardctl graft upgrade notes`, or remove the graft.

## needs Orchard

```text
needs Orchard >=2.70.0 <3, this is 2.67.0
```

**Cause:** This version of the graft does not support your Orchard version.

**Fix:** Upgrade Orchard, or install a version of the graft that lists your Orchard version. `sudo orchardctl graft info <id>` shows which versions are compatible.

## migration was changed after it was applied

```text
migration 0001_init was changed after it was applied (checksum mismatch); ship a new migration instead
```

**Cause:** A published graft version edited a migration that your database already ran.

**Fix:** Contact the publisher. To return to the previous version, refer to [Roll back a graft](/grafts/upgrades/#roll-back-a-graft).

## A claim shows as taken

**Cause:** In **Instance admin** > **Grafts**, `taken by` next to a claim means another graft uses the name.

**Fix:** No action is needed for the graft to work. It still serves its paths under `/<graft-id>/`.

## A graft misbehaves or Orchard does not start

With `graftSettings.strict` off, which is the default, Orchard skips a broken graft and starts without it. With `graftSettings.strict` on, a graft that fails stops the pod.

To turn off every graft at once, run the following command:

```sh
sudo orchardctl config set graftSettings.safeMode true --apply
```

Remove the failing graft, then set `graftSettings.safeMode` back to `false`.

## Still stuck?

Collect the phase and reason from **Instance admin** > **Grafts**, and the output of `sudo orchardctl graft list`. Then contact the graft's publisher. Its details are on its [Extension Marketplace](https://orchard.my/extensions) page.
