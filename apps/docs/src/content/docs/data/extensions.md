---
title: Extensions
description: Install PostgreSQL extensions without a shell.
sidebar:
  order: 4
---

The **Extensions** tab lists what is available on the image and what is currently
installed, and installs or removes them for you. No `psql` session, no superuser
juggling.

Common ones people reach for:

| Extension                | For                                     |
| ------------------------ | --------------------------------------- |
| `uuid-ossp` / `pgcrypto` | UUID generation, hashing                |
| `postgis`                | Geospatial types and queries            |
| `pg_trgm`                | Fuzzy text search and trigram indexes   |
| `vector`                 | Embedding storage and similarity search |
| `hstore`                 | Key-value pairs in a column             |

## Notes

Installing an extension runs `CREATE EXTENSION` against the database, so it takes
effect immediately and applies to that database only.

Removing one runs `DROP EXTENSION`, which fails if objects still depend on it.
That failure is a feature: drop the dependent objects first, deliberately.

Extensions have to exist in the PostgreSQL image the cluster runs. If something
you need is missing, it is an instance-level change to the image rather than
something a tenant can install.
