# Docs

The documentation site at <https://docs.orchard.hackclub.com>. Built with Astro and Starlight, with
`starlight-openapi` for the API reference.

## Run it

```sh
pnpm --filter docs dev       # http://localhost:5174
pnpm --filter docs build     # runs generate, then astro build into dist/
pnpm --filter docs preview   # serves the build on :5174
```

`build` runs `generate` first, which needs Go (see below).

## Layout

- `src/content/docs/`: the pages, as `.md` or `.mdx`. The folder is the URL, so
  `deploy/domains.mdx` is `/deploy/domains/`.
- `astro.config.mjs`: the sidebar. It is listed by hand, so a new page needs an entry there or it
  will not show up in the navigation. Redirects for moved pages live here too.
- `src/pages/`: pages outside the content collection: the home page, `/directory/`, `/agent-setup/`,
  and the Markdown endpoints. Every page is also served as Markdown at its URL plus `.md`, and the
  site publishes `llms.txt`, `llms-full.txt` and a `llms.txt` per section.
- `src/overrides/`: Starlight components replaced with our own (header, sidebar, footer, theme).
- `src/components/`, `src/lib/`: shared components and helpers for the above.
- `src/styles/`: `orchard.css` is hand-written. `palette.css` is generated.
- `public/`: favicons, logos, fonts and `third-party-notices.txt`.

## Generated files

Don't edit these by hand. CI runs `pnpm --filter docs check:generated`, which regenerates and fails
if anything changed.

| File                                           | Comes from                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `src/content/docs/reference/cli.mdx`           | the CLI's own command tree (`go run . commands -o json` in `apps/cli`)  |
| `src/content/docs/reference/mcp-tools.mdx`     | the MCP tools in `apps/server/src/mcp/tools` and each graft's `mcp/src` |
| `src/content/docs/reference/configuration.mdx` | `.env.example` at the repo root                                         |
| `src/content/docs/reference/graft-api.mdx`     | `apps/server/test/graft-api.snapshot.json`                              |
| `src/content/docs/reference/graft-slots.mdx`   | the frontend's slot map in `apps/frontend/src/lib/grafts/types.ts`      |
| `openapi.generated.json`                       | `packages/contracts/openapi.json`, rendered under `/api/`               |

Regenerate them all with:

```sh
pnpm --filter docs generate
```

Run it whenever you change an API route, a CLI command, an MCP tool or `.env.example`. For an API
route, update the contracts first (see [AGENTS.md](../../AGENTS.md)).

`src/styles/palette.css` is generated from the frontend's theme code in
`apps/frontend/src/lib/theme`. The rest of the styling uses the frontend's design tokens from
`apps/frontend/src/lib/design/tokens.css`. Regenerate the palette with:

```sh
pnpm --filter docs gen:palette
```

`public/third-party-notices.txt` is written by `pnpm credits` at the repo root.

## Shipping

CI builds the site and checks the generated files on any pull request that touches `apps/docs`. The
docs are not part of release-please, and there is no deploy workflow in this repo.

## Brand assets

The Orchard logos and favicons in `public/logo/`, `public/favicon/` and `src/assets/` are covered by
[TRADEMARK.md](../../TRADEMARK.md). A fork that redistributes a modified version must replace them.
