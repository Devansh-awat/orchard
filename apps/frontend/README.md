# Orchard frontend

SvelteKit + Svelte 5 web app for Orchard.

## Develop

Run from the repo root so the gateway and API come up too:

```bash
pnpm dev
```

Open http://localhost:4000: the gateway proxies the API; running Vite alone
on :3000 breaks logins.

Frontend-only commands:

```bash
pnpm --filter frontend dev              # vite on :3000
pnpm --filter frontend build
pnpm --filter frontend format
pnpm --filter frontend check:design     # design-system guardrails
```

Env vars live in `.env` (see `.env.example`); all client-visible values use
the `PUBLIC_` prefix via `$env/dynamic/public`.

## Design system

Read `DESIGN.md` before writing UI: semantic tokens only (no hex colors in
`.svelte` files), `ui/` components over legacy classes, spring physics via
`$lib/utils/motion.svelte` for any movement. `pnpm check:design` fails diffs
that regress the basics.
