---
title: Get started
description: Build an Orchard graft by scaffolding it with the graft CLI, running it against a local Orchard, and packing and signing it. You need Node.js, pnpm, and a local Orchard dev stack.
sidebar:
  order: 1
---

Build a graft when Orchard is missing something your team needs. In this guide, you scaffold a graft, run it against your local Orchard, and pack it into a signed file that any instance can install.

A graft is a folder with a [`graft.json`](/grafts/build/manifest/). It can also have a NestJS module for the API, a Svelte island for the UI, SQL migrations, and MCP tools. The `graft` command in `@orchardlabs/graft-sdk` builds, packs, and signs it.

## Prerequisites

- Node.js and pnpm.
- A local Orchard dev stack. To set one up, follow [Getting set up](https://github.com/hackclub/orchard/blob/main/CONTRIBUTING.md#getting-set-up) in the repository's contributing guide.

## 1. Scaffold a graft

```sh
npx -p @orchardlabs/graft-sdk graft init snippets
cd snippets
pnpm install
```

The command creates these files:

```text
snippets/
  graft.json                 what the graft is and what it asks for
  package.json
  README.md
  server/src/index.ts        NestJS module, default export
  ui/src/client.ts           defineGraft({ slots, screens })
  ui/src/Home.svelte
  migrations/0001_init/migration.sql
  tsconfig.json
```

## 2. Run the graft

In the graft's folder, run the following command:

```sh
graft dev
```

The command builds into `.graft-dev/` and rebuilds when a file changes.

Start the Orchard server and frontend with these variables:

```sh
ORCHARD_GRAFTS_DIR=/path/to/snippets/.graft-dev ORCHARD_GRAFTS_DEV=1
```

`ORCHARD_GRAFTS_DEV` skips signature checks for local work.

The graft's pages are at `http://localhost:4000/snippets`, and its API is at `/apiv1/snippets/...`. **Instance admin** > **Grafts** shows its status.

UI changes appear when you reload the page. Restart the API server to pick up server changes and new migrations.

## 3. Check, pack, and sign

```sh
graft doctor
graft keygen ~/.config/graft/key.pem
graft pack --key ~/.config/graft/key.pem
```

`graft doctor` checks `graft.json` and the migrations for common mistakes.

`graft pack` does the following:

1. It builds everything.
2. It records each route and its access level in `routes.json`.
3. It works out which [doors](/reference/graft-api/) the graft uses.
4. It hashes each file into `MANIFEST.json`, and signs that list.
5. It writes `snippets-0.1.0.graft`, and prints the Helm entry to install it.

`graft pack` fails if a route open to anyone is not listed in `graft.json`, or if the code uses a door without its capability.

Keep the private key secret. To let people trust your grafts, share the public key that `graft keygen` prints.

## Licenses

`@orchardlabs/graft-sdk` is MIT licensed, so a graft that only imports it can use any license. `@orchardlabs/graft-ui` is licensed under AGPL-3.0-only. A graft that imports `@orchardlabs/graft-ui` must be released under a license compatible with AGPL-3.0-only, and the AGPL's source-sharing terms apply to it. To use another license, build the graft's UI with `@orchardlabs/graft-sdk` and your own components.

## Next steps

- [Review each field of the manifest](/grafts/build/manifest/)
- [Add API routes and reach Orchard through doors](/grafts/build/server/)
- [Add pages, navigation, tabs, and cards](/grafts/build/ui/)
- [Add migrations and read Orchard's tables](/grafts/build/database/)
- [Share your graft or list it in the Extension Marketplace](/grafts/build/publishing/)

For an example, read the [announcements graft](https://github.com/hackclub/orchard/tree/main/grafts/announcements). It has a server module, UI, migrations, and settings.

## Related resources

- [Graft UI slots](/reference/graft-slots/) - Every place in the dashboard a graft can add to.
- [Graft API versions](/reference/graft-api/) - Doors, their members, and the capability each needs.
- [Troubleshooting grafts](/grafts/troubleshooting/) - Find out why a graft did not load.
