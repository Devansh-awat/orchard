# Orchard: Agent Guide

## Code style

- Never add comments to code. No inline comments, no block comments, no doc comments. Write the code so it reads on its own.
- Use pnpm, never bun or npm.
- Don't run `tsc`/`svelte-check`; they're slow and have pre-existing noise. Use `pnpm lint` (oxlint) and targeted builds instead.
- Format with `pnpm format` (oxfmt). Do not use eslint or prettier.

## Repo map

- `apps/frontend`: SvelteKit + Svelte 5 web app. Design rules in `apps/frontend/DESIGN.md` and `apps/frontend/CLAUDE.md`.
- `apps/server`: NestJS API, Prisma (Postgres), ~24 feature modules under `src/`. Auth in `src/auth`, k8s orchestration in `src/kubernetes`, builds in `src/docker`, tenant resources in `src/projects`.
- `apps/landing`: the public marketing site (orchard.my), its own SvelteKit app on `:5173`, Tailwind only, no shared UI with `apps/frontend`.
- `apps/gateway`: Go dev/edge reverse proxy (`:4000` → API `:3001` + Vite `:3000`).
- `apps/r2-proxy`: Go proxy that issues per-cluster scoped credentials for database backups to R2.
- `apps/cli`: Go CLI (`orchard`), Cobra + Bubbletea. Agent notes in `apps/cli/AGENTS.md`.
- `packages/contracts`: shared route/DTO types, generated from the server's auth-coverage snapshot.
- `infra/charts/orchard`: Helm chart for deploying Orchard itself (install guide in its `AGENT.md`).

## Environment & config

- Server env surface is documented in `.env.example` (copy to `apps/server/.env`). Frontend `PUBLIC_*` vars in `apps/frontend/.env.example`.
- Local deps come from `docker-compose.dev.yml` (Postgres 16 + Redis). Postgres is required at boot; Redis and Kubernetes are optional and degrade.
- Cluster-specific knobs (storage class, ingress class, registry, wildcard cert domains) are env vars, not literals: keep it that way when touching k8s/build code.
- App HTTP metrics come from the ingress controller through adapters in `apps/server/src/metrics/ingress/`
  (one file per controller, registered in `index.ts`). An adapter turns a namespace and its services into
  PromQL for requests, status classes, error %, latency (percentiles only if the controller has
  histograms) and per-route stats; observability, the Observe dashboard and HTTP alerts all go through it.
  To support another controller: add `<name>.ts` implementing `IngressAdapter`, register it, add a scrape
  job for its metrics in `infra/charts/orchard/templates/metrics.yaml`, and extend `ingress-metrics.test.ts`.
  The server detects the adapter per app from the metrics store; `INGRESS_METRICS` forces one.

## Conventions

- Conventional Commits, enforced by commitlint; release-please cuts per-service releases from them.
- After adding or upgrading a dependency, run `pnpm credits`. It rebuilds each app with sourcemaps,
  then refreshes the credits page data (`apps/landing/src/lib/credits.generated.json`) and the
  third-party notices every artifact ships (`THIRD_PARTY_NOTICES.txt` or `third-party-notices.txt`
  in each app; the CLI and orchardctl embed theirs). Fix anything it reports before committing.
- New API endpoints must be recorded in the auth-coverage snapshot (`UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage`).
- Prisma migrations: `pnpm --filter server prisma:migrate` for dev; never edit applied migrations.
- Typecheck errors claiming a schema column "does not exist" mean a stale generated client, not a
  missing migration. Check `schema.prisma` first, then `pnpm prisma:generate`.
- A URL is server-computed, never assembled client-side. The API returns `url` on every ingress it
  serialises (`scrubIngress`), because an instance may serve on ports other than 80 and 443 and the
  hostname alone does not say so. Adding a new ingress payload means selecting `host`, `path`,
  `tlsSecretName` and `entrypoints` and mapping it through `scrubIngress`.
