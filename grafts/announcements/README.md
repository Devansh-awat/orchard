# Announcements

The hello-world graft. Superadmins post notices from Admin → Announcements; everyone sees
them on project and app overviews.

It shows every part of a graft: its own database schema and migration, the `db` and
`audit` doors, a superadmin-only route through default-deny, an admin nav entry, a full
screen, and cards in two slots.

```
pnpm --filter @grafts/announcements pack
```
