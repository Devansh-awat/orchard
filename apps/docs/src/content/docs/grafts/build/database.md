---
title: Use the database
description: Add migrations to an Orchard graft's own Postgres schema, read declared columns from Orchard's tables, and connect through the db door.
sidebar:
  order: 5
---

Store a graft's data in its own Postgres schema. The schema is named `ext_<graft_id>`, with dashes turned into underscores. Orchard creates it, runs the graft's migrations in it, and points the graft's connections at it. A migration writes `CREATE TABLE notes` and does not name the schema.

## Add a migration

Add a folder under `migrations/` with a `migration.sql` file:

```text
migrations/
  0001_init/migration.sql
  0002_pinned/migration.sql
```

Folders run in name order, and each runs once. A graft's pending migrations run in one transaction.

A migration that cannot run in a transaction starts with a marker, and runs on its own:

```sql
-- graft:no-transaction
CREATE INDEX CONCURRENTLY notes_body ON notes (body);
```

`graft doctor` notes these migrations.

Follow these rules:

- **Do not edit a released migration.** Orchard checksums each one and refuses a graft whose history changed. Add a new migration.
- **Support two versions during a rollout.** Old and new pods run side by side. Add new structures in one version, and remove what they replace in the next.
- **Change only your own schema.** You can read core tables. `graft doctor` reports a problem for migrations that change them, unless the graft lists them in `database.adopts`.

## Read Orchard's tables

Declare the core columns you need in `graft.json`, and join against them as `public.<table>`:

```json
{ "database": { "coreReads": { "users": ["id", "username"] } } }
```

```sql
SELECT n.body, u.username
  FROM notes n
  LEFT JOIN public.users u ON u.id = n.created_by;
```

Foreign keys to core tables are allowed. Use `ON DELETE CASCADE` or `ON DELETE SET NULL`, so that a deleted user or project does not leave orphaned rows.

When the database user can create roles, the graft's connections run as `orchard_ext_<graft_id>`. This role can use the graft's schema and read only the declared columns.

:::note
The role catches mistakes only. The graft's code runs inside Orchard, so the role is not a security boundary.
:::

## Connect to the database

`Doors.db` gives you a `pg` pool that points at the schema:

```ts
const { rows } = await this.db.query('SELECT * FROM notes WHERE id = $1', [id]);
```

To use a query builder or an ORM that accepts a `pg` pool, call `this.db.pool()`.

The pool holds 3 connections per pod by default. To ask for more, up to 50, set this in `graft.json`:

```json
"database": { "pool": 10 }
```

Operators can override the size with `orchardctl graft pool`. Orchard checks the pools of all pods against the database's limit. For more information, refer to [Database connections](/grafts/install/#database-connections).

## Related resources

- [graft.json](/grafts/build/manifest/)
- [Upgrade and roll back grafts](/grafts/upgrades/)
