---
title: Database
description: A graft's own schema, its migrations, and reading Orchard's tables.
sidebar:
  order: 5
---

Each graft gets a Postgres schema of its own, `ext_<graft_id>` (dashes become
underscores). Orchard creates it, runs the graft's migrations in it, and points
the graft's connections at it, so a migration writes `CREATE TABLE notes` and
never names the schema.

## Migrations

```text
migrations/
  0001_init/migration.sql
  0002_pinned/migration.sql
```

Folders run in name order and each runs once. All of a graft's pending
migrations run in one transaction, so they apply together or not at all. A
migration that cannot run in a transaction starts with:

```sql
-- graft:no-transaction
CREATE INDEX CONCURRENTLY notes_body ON notes (body);
```

and runs on its own. `graft doctor` points these out.

Rules that keep upgrades safe:

- **Never edit a released migration.** Orchard checksums each one and refuses
  a graft whose history changed. Add a new migration instead.
- **Old and new versions run side by side during a rollout.** Add things in one
  version and remove what replaced them in the next.
- **Only change your own schema.** Reading core tables is fine; changing them is
  not, and `graft doctor` refuses migrations that try.

## Reading Orchard's tables

Declare the core columns you need, and join against them as `public.<table>`:

```json
{ "database": { "coreReads": { "users": ["id", "username"] } } }
```

```sql
SELECT n.body, u.username
  FROM notes n
  LEFT JOIN public.users u ON u.id = n.created_by;
```

Foreign keys to core tables are allowed, usually with `ON DELETE CASCADE` or
`SET NULL` so a deleted user or project does not strand rows.

When the database user may create roles, the graft's connections run as
`orchard_ext_<graft_id>`, which can use its own schema and read only the
declared columns. That catches mistakes; it is not a security boundary, because
the graft's code runs inside Orchard.

## Connecting

`Doors.db` gives a `pg` pool already pointed at the schema:

```ts
const { rows } = await this.db.query('SELECT * FROM notes WHERE id = $1', [id]);
```

Any query builder or ORM that accepts a `pg` pool works with `this.db.pool()`.
The pool holds 3 connections per pod unless you ask for more in `graft.json`:

```json
"database": { "pool": 10 }
```

Ask for what the graft needs under load, up to 50; operators can override it
with `orchardctl graft pool`, and Orchard checks every pod's pools together
against the database's limit (see [Database connections](/grafts/install/#database-connections)).
Keep transactions short either way.
