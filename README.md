# Orchard

A self-service deployment platform on Kubernetes — deploy from GitHub, manage
databases, organizations, quotas, and compose stacks, with a SvelteKit web app,
a NestJS API, and supporting Go services.

## Monorepo layout

```
apps/                  deployable units (one container image each)
  web/  → frontend     SvelteKit web app          (apps/frontend)
  api/  → server       NestJS API + Prisma         (apps/server)
  gateway              Go edge gateway             (apps/gateway)
  r2-proxy             Go R2 storage proxy          (apps/r2-proxy)
  cli                  Go CLI (`orchard`)           (apps/cli)
packages/              shared, importable code (not deployed)
infra/                 charts/ (Helm) · k8s/ · datadog/ · cron.yaml
docs/                  design + architecture notes
```

> `apps/*` = things you **deploy** (have a Dockerfile, get released).
> `packages/*` = things you **import** (shared code, never deployed).

## Develop

```bash
pnpm install                 # install JS workspaces (frontend, server, gateway)
cp .env.example .env         # fill in the blanks
pnpm dev                     # frontend + server + gateway in parallel
```

Per-service:

```bash
pnpm --filter frontend dev
pnpm --filter server dev
pnpm --filter server prisma:generate
cd apps/cli && go run .      # Go services
```

## Release & CI

- **PRs** run checks in GitHub Actions, skipping components that didn't change.
- **`main`** runs release-please; each service is versioned independently
  (`<service>/vX.Y.Z`) from [Conventional Commits](https://www.conventionalcommits.org/),
  and only bumped services build + publish their image to GHCR.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the service-split roadmap.
