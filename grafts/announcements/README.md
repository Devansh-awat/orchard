# Announcements

Post instance-wide notices that appear on project and app overview pages. Superadmins manage notices in **Admin** > **Announcements**.

This graft is a small example of a graft's parts:

- A database schema and migrations.
- The `db`, `audit`, and `settings` doors.
- A superadmin-only route, through the default access rule.
- An admin navigation entry and a screen.
- Cards in two slots.

To pack the graft, run:

```
pnpm --filter @grafts/announcements pack
```
