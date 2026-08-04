# Updates

Each file in this folder is one product update. `UpdatesModal` shows the newest one
once per user, then never again.

"Seen" lives on the user row in postgres (`users.seen_updates`, a text array), not in
localStorage, so dismissing it on your laptop also dismisses it on your phone. The
frontend reads the array off `/apiv1/auth/me` and appends to it with
`POST /apiv1/auth/me/seen-updates` when the sheet is dismissed.

Only the newest file is ever shown. Older ones stay here as a record.

## Adding one

Drop in a new markdown file. The name is up to you, `YYYY-MM-DD-slug.md` keeps the
folder sorted. Ordering and "which one is newest" come from the `date` field, not
the filename.

```md
---
id: pipelines
title: Pipelines are here
date: 2026-09-14
tag: New
summary: One line under the title. Keep it short.
---

### [rocket] A section title

One line. Say what the feature is, then why you'd want it.

### [gauge] Another one

Four sections is about all that fits without scrolling.
```

`id` is what gets stored against every user, so never reuse one and never change it
after release. Everything above the first `###` renders as an intro paragraph.

A file without `id` and `date` in its frontmatter is ignored, which is why this README
does not turn into an update.

## Icons

`[name]` in front of a section title picks its icon. Available names live in the
`icons` map in `$lib/components/UpdatesModal.svelte`:

`sparkles`, `motion`, `observe`, `bell`, `gauge`, `rocket`, `shield`

Add more by importing another lucide icon into that map. An unknown name falls back
to `sparkles`.

## Seeing it again

Clear your own row and reload:

```sql
UPDATE users SET seen_updates = '{}' WHERE email = 'you@example.com';
```
