# The Grove

Add a forum to an Orchard instance. The Grove has bug reports and feature requests with votes, replies, and image attachments. Superadmins set each thread's status and priority, and can pin and lock threads.

The graft adopts the `forum_*` tables that older Orchard releases keep in core, so an existing Grove keeps its threads. Image uploads use the `storage` door, and need object storage configured.

To pack the graft, run:

```
pnpm --filter @grafts/forum pack
```
