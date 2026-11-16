# Landing

The marketing site at <https://orchard.hackclub.com>. A SvelteKit app styled with Tailwind. It shares
no UI code with `apps/frontend`.

## Run it

```sh
pnpm --filter landing dev       # http://localhost:5173
pnpm --filter landing build     # adapter-node output in build/
pnpm --filter landing preview
```

The build is a Node server, not static files, because some pages load data at request time. Start a
build with `node build`.

## Layout

- `src/routes/`: one folder per page. The home page is `+page.svelte`, and the others are
  `compare`, `self-hosted-paas`, `credits`, `templates` and `extensions`, plus `llms.txt` and
  `sitemap.xml`.
- `src/lib/components/`: the sections of the home page and the pieces they share.
- `src/lib/server/`: server-only code. `registry.ts` reads templates and extensions from the Orchard
  registry.
- `src/lib/credits.generated.json`: written by `pnpm credits` at the repo root. Don't edit it by
  hand.
- `static/`: logos, brand art, Hack Club imagery, fonts, favicons and `og.png`.

## Environment

Both variables are optional.

- `REGISTRY_URL`: where `/templates` and `/extensions` read from. Defaults to
  `https://assets.orchard.my/registry`.
- `GITHUB_TOKEN`: used by `/credits` when it asks the GitHub API for contributors, to avoid the
  unauthenticated rate limit.

## Shipping

CI builds the site on any pull request that touches `apps/landing`. The site is not part of
release-please, and there is no deploy workflow in this repo.

## Brand assets

This site holds most of the project's brand assets: the Orchard logos and the Hack Club name, logo,
Orpheus mascot and photos. They are not covered by the AGPL. Forks that redistribute a modified
version must replace them. [TRADEMARK.md](../../TRADEMARK.md) lists every covered path, including:

- `static/logo/`, `static/favicon/`, `static/brand/`, `static/hackclub/`
- `src/lib/components/Logo.svelte`, `HackClub.svelte`, `HackClubFlag.svelte`
- `src/lib/mark.ts`, `src/lib/mark3d.ts`
