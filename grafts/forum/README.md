# The Grove

A forum for the people on an instance: bug reports and feature requests with votes,
replies, image attachments, and superadmin triage (status, priority, pin, lock).

It adopts the `forum_*` tables that used to live in core, so an existing Grove keeps its
threads. Image uploads go through the `storage` door and need object storage configured.

```
pnpm --filter @grafts/forum pack
```
