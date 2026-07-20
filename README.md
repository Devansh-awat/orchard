# Orchard

A self-service deployment platform on Kubernetes — deploy from GitHub, manage
databases, organizations, quotas, and compose stacks, with a SvelteKit web app,
a NestJS API, and supporting Go services.

## Monorepo layout

```
apps/                  deployable units (one container image each)
  frontend             SvelteKit web app
  server               NestJS API + Prisma
  gateway              Go edge gateway
  r2-proxy             Go R2 storage proxy
  cli                  Go CLI (`orchard`)
packages/              shared, importable code (not deployed)
infra/                 charts/ (Helm) · k8s/ · datadog/
docs/                  design + architecture notes
```

> `apps/*` = things you **deploy** (have a Dockerfile, get released).
> `packages/*` = things you **import** (shared code, never deployed).

## Develop

Prereqs: Node 22+, pnpm 10, Go 1.22+ (1.26 for the CLI), Docker.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d    # Postgres 16 + Redis

cp .env.example apps/server/.env                  # defaults boot as-is
cp apps/frontend/.env.example apps/frontend/.env

pnpm --filter server prisma:generate
pnpm --filter server prisma:migrate               # apply migrations
pnpm --filter server prisma:seed                  # demo data

pnpm dev                                          # frontend + server + gateway
```

Open http://localhost:4000 (the gateway proxies `/apiv1/*` to the API on 3001
and everything else to Vite on 3000 — always use :4000 or logins break).

The seed gives you `admin@orchard.dev` in the `orchard-demo` org; sign in with
an email OTP (codes print to the server console when SMTP is unconfigured).

A Kubernetes cluster is **not** required for UI/API development — the server
boots without one and deploy/build features return 503 until you point
`KUBECONFIG_PATH` at a cluster. See `docs/self-hosting.md` for running the
full platform.

Per-service:

```bash
pnpm --filter frontend dev
pnpm --filter server dev
cd apps/cli && go run .      # Go services
```

Tests:

```bash
pnpm --filter server test:auth-coverage   # route/auth snapshot (no DB needed)
pnpm --filter server test:rbac            # e2e, needs a running server + DB
cd apps/cli && go test ./...
```

## Release & CI

- **PRs** run checks in GitHub Actions, skipping components that didn't change.
- **`main`** runs release-please; each service is versioned independently
  (`<service>/vX.Y.Z`) from [Conventional Commits](https://www.conventionalcommits.org/),
  and only bumped services build + publish their image to GHCR.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the service-split
roadmap and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the PR workflow.

## License

[AGPL-3.0](LICENSE)
