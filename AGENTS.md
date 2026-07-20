# Orchard: Agent Guide

## Code style

- Never add comments to code. No inline comments, no block comments, no doc comments. Write the code so it reads on its own.
- Use pnpm, never bun or npm.
- Don't run `tsc`/`svelte-check`; they're slow and have pre-existing noise. Use `pnpm lint` and targeted builds instead.

## Repo map

- `apps/frontend`: SvelteKit + Svelte 5 web app. Design rules in `apps/frontend/DESIGN.md` and `apps/frontend/CLAUDE.md`.
- `apps/server`: NestJS API, Prisma (Postgres), ~24 feature modules under `src/`. Auth in `src/auth`, k8s orchestration in `src/kubernetes`, builds in `src/docker`, tenant resources in `src/projects`.
- `apps/gateway`: Go dev/edge reverse proxy (`:4000` → API `:3001` + Vite `:3000`).
- `apps/r2-proxy`: Go proxy that issues per-cluster scoped credentials for database backups to R2.
- `apps/cli`: Go CLI (`orchard`), Cobra + Bubbletea. Agent notes in `apps/cli/AGENTS.md`.
- `packages/contracts`: shared route/DTO types, generated from the server's auth-coverage snapshot.
- `infra/charts/orchard`: Helm chart for deploying Orchard itself (install guide in its `AGENT.md`).

## Environment & config

- Server env surface is documented in `.env.example` (copy to `apps/server/.env`). Frontend `PUBLIC_*` vars in `apps/frontend/.env.example`.
- Local deps come from `docker-compose.dev.yml` (Postgres 16 + Redis). Postgres is required at boot; Redis and Kubernetes are optional and degrade.
- Cluster-specific knobs (storage class, ingress class, registry, wildcard cert domains) are env vars, not literals: keep it that way when touching k8s/build code.

## Conventions

- Conventional Commits, enforced by commitlint; release-please cuts per-service releases from them.
- New API endpoints must be recorded in the auth-coverage snapshot (`UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage`).
- Prisma migrations: `pnpm --filter server prisma:migrate` for dev; never edit applied migrations.
