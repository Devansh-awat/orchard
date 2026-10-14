---
title: Build a graft
description: Scaffold a graft, run it against your local Orchard, then pack and sign it.
sidebar:
  order: 1
---

A graft is a folder with a `graft.json`, and any of: a NestJS module for the API,
a Svelte island for the UI, SQL migrations for its own tables and MCP tools for
agents. The `graft` command in `@orchardlabs/graft-sdk` builds, packs and signs it.
The [announcements graft](https://github.com/hackclub/orchard/tree/main/grafts/announcements)
in the Orchard repository uses every part and is the best example to copy.

`@orchardlabs/graft-sdk` is MIT licensed, so your graft can use any license you
like. The UI kit, `@orchardlabs/graft-ui`, is a copy of Orchard's own components
and stays AGPL like Orchard: a graft that bundles it shares that license.

## Scaffold

```sh
npx -p @orchardlabs/graft-sdk graft init snippets
cd snippets
pnpm install
```

```text
snippets/
  graft.json                 what the graft is and what it asks for
  server/src/index.ts        NestJS module, default export
  ui/src/client.ts           defineGraft({ slots, screens })
  ui/src/Home.svelte
  migrations/0001_init/migration.sql
  tsconfig.json
```

## Run it against your Orchard

Run your local Orchard dev stack as usual (see the repository README), then in
the graft:

```sh
graft dev
```

It builds into `.graft-dev/` and rebuilds on every save. Start the Orchard
server and frontend with:

```sh
ORCHARD_GRAFTS_DIR=/path/to/snippets/.graft-dev ORCHARD_GRAFTS_DEV=1
```

`ORCHARD_GRAFTS_DEV` skips signature checks for local work. UI changes appear
on reload; restart the API server to pick up server changes and new migrations.
Your graft's pages are at `http://localhost:4000/snippets`, its API at
`/apiv1/snippets/...`, and Admin → Grafts shows how Orchard sees it.

## Check, pack and sign

```sh
graft doctor            # graft.json and migrations, common mistakes
graft keygen ~/.config/graft/key.pem
graft pack --key ~/.config/graft/key.pem
```

`pack` builds everything, records every route and its access level in
`routes.json`, works out which [doors](/reference/graft-api/) the graft uses,
hashes every file into `MANIFEST.json`, signs that list, and writes
`snippets-0.1.0.graft` with the Helm entry to install it. Keep the private key
secret; share the public key `keygen` printed so people can trust your grafts.

`pack` stops when something would be refused at install time: a route open to
anyone that `graft.json` does not list, or a door used without its capability.

## Next

- [graft.json](/grafts/build/manifest/)
- [Server code and doors](/grafts/build/server/)
- [UI islands and slots](/grafts/build/ui/)
- [Database](/grafts/build/database/)
- [Publishing](/grafts/build/publishing/)
