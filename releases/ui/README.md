# UI release notes

This folder is its own release track (`ui`, tags `ui/vX.Y.Z`). Committing here bumps only
the `ui` version; the frontend, server and every other app keep theirs.

When release-please cuts a `ui` release, the release workflow uploads
`notes/<version>.md` and a `latest.json` to `assets.orchard.my/updates/ui/`. Every Orchard
instance reads that through `GET /apiv1/updates/latest` and shows the note once per user in
the What's new sheet (`UpdatesModal`). No deploy is needed for a note to appear.

## Shipping a note

1. Add `notes/<next version>.md`.
2. Commit only that file. `feat(ui): ...` makes a minor release, `feat(ui)!: ...` a major one.
3. Merge the release PR. The note goes live a few minutes later.

```md
---
id: ui-v3
title: Orchard UI 3
date: 2026-10-31
tag: UI V3
summary: One line under the title. Keep it short.
---

### [sparkles] A section title

One line. Say what changed, then why you'd care.
```

`id` is stored against every user who dismisses the sheet, so never reuse one and never
change it after release. Everything above the first `###` renders as an intro paragraph.
Four sections is about all that fits without scrolling.

## Icons

`[name]` picks a section icon from the `icons` map in
`apps/frontend/src/lib/components/UpdatesModal.svelte`: `sparkles`, `motion`, `observe`,
`bell`, `gauge`, `rocket`, `shield`. Unknown names fall back to `sparkles`.

## Self-hosting

`UPDATES_URL` on the server points at another folder with the same `latest.json` and notes,
or `off` turns the sheet off.

## Seeing it again

```sql
UPDATE users SET seen_updates = array_remove(seen_updates, 'ui-v3') WHERE email = 'you@example.com';
```
