# Orchard: Agent Guide

Orchard is a PaaS that installs into a Kubernetes cluster you own. This file is for agents changing
this repo. To drive a running instance through the CLI, read `apps/cli/AGENTS.md` instead. For how
the system works, read `DEVELOPERS.md`.

## Code style

- Don't add comments to code. Tool directives such as `//go:build` or `svelte-ignore` are the
  exception.
- Use pnpm (pinned in `package.json`), never bun or npm. Go modules target Go 1.26.
- Don't run `tsc` or `svelte-check` locally; they're slow and have pre-existing noise. CI typechecks.
  Use `pnpm lint` (oxlint plus the frontend design check) and targeted builds.
- Format with `pnpm format` (oxfmt). Do not use eslint or prettier.

## Repo map

Deployed (`apps/`):

- `apps/frontend`: SvelteKit + Svelte 5 web app. Rules in `apps/frontend/DESIGN.md` and
  `apps/frontend/AGENTS.md`. `pnpm dev:mock` runs it with no backend.
- `apps/server`: NestJS API and Prisma (Postgres). Auth in `src/auth`, k8s orchestration in
  `src/kubernetes`, the cluster mirror in `src/engine`, builds in `src/docker`, tenant resources in
  `src/projects`.
- `apps/server/hostctl`: `orchardctl`, the commands installed on an Orchard host. It ships with the
  server image.
- `apps/gateway`: Go dev/edge reverse proxy (`:4000` to API `:3001` and Vite `:3000`). Always open
  `:4000` in dev.
- `apps/cli`: Go CLI (`orchard`), Cobra + Bubbletea, plus the OpenTofu provider in `tofu-provider`.
- `apps/landing`: the marketing site (orchard.hackclub.com) on `:5173`. Tailwind only, no shared UI with
  `apps/frontend`.
- `apps/docs`: docs.orchard.hackclub.com, Astro Starlight on `:5174`. `src/content/docs/reference` is generated. Styles use the design tokens from `apps/frontend/src/lib/design`, with its own palette from `pnpm --filter docs gen:palette`.
- `apps/r2-proxy`: Go proxy that issues per-cluster scoped credentials for database backups to R2.
- `apps/registry`: Go service that serves and publishes templates and grafts.
- `apps/fc-builder`: Firecracker microVM image builder.

Everything else:

- `grafts/`: first-party extensions (`greenhouse`, `forum`, `announcements`).
- `registry/`: template and community graft content that `apps/registry` publishes.
- `packages/contracts`: route list, schemas and OpenAPI, generated from the server's auth-coverage
  snapshot.
- `packages/graft-sdk`, `packages/graft-ui`: what grafts build against.
- `packages/health`: shared health copy, kept in sync with the server by a test.
- `infra/charts/orchard`: the Helm chart. Values reference in its `README.md`.
- `install/`: the one-command installer, published to `assets.orchard.my/install.sh`.
- `docs/`: architecture and design notes.

## Environment & config

- Server env surface is documented in `.env.example` (copy to `apps/server/.env`). Frontend
  `PUBLIC_*` vars are in `apps/frontend/.env.example`.
- Local deps come from `docker-compose.dev.yml` (Postgres 16 + Redis). Postgres and `JWT_SECRET` are
  required at boot; Redis and Kubernetes are optional and degrade.
- Cluster-specific knobs (storage class, ingress class, registry, wildcard cert domains) are env
  vars, not literals: keep it that way when touching k8s/build code.
- App HTTP metrics come from the ingress controller through adapters in
  `apps/server/src/metrics/ingress/` (one file per controller, registered in `index.ts`). To support
  another controller: add `<name>.ts` implementing `IngressAdapter`, register it, add a scrape job in
  `infra/charts/orchard/templates/metrics.yaml`, and extend `ingress-metrics.test.ts`. The server
  detects the adapter per app; `INGRESS_METRICS` forces one.

## Architecture rules

How the server talks to the cluster and the dashboard. `DEVELOPERS.md` has the full story; these are
the rules that are easy to break. Paths are under `apps/server/src`.

- **Read cluster state from the mirror.** The engine (`engine/`) watches the cluster and mirrors it
  into Postgres: `k8s_objects` (`prisma.k8sObject`) plus the tables its consumers derive (`pods`,
  `k8s_workloads`, `nodes`). Request paths read those, never the Kubernetes API; a page load should
  not call the apiserver. A live read is an explicit opt-in, as with `?live=1` on
  `GET /kubernetes/pods`. Mirrored Secrets have their data stripped, so secret values never come from
  the mirror.
- **Watch new kinds through the engine.** Add an `EngineResource` to a shard in `engine/shards.ts`
  and a consumer in `engine/consumers/`; grafts use `registerEngineShard` through the kube door. Do
  not add another `makeInformer` service: the `*-informer.service.ts` files are legacy and the pod,
  CNPG and job ones only run with `ENGINE_DISABLED=true`. `onEvent` must throw on failure, because a
  swallowed error marks the version derived and it is never retried. The engine only sees labelled
  objects (`app.kubernetes.io/managed-by=orchard`, `leaf.dev/managed=true` on ingresses,
  `orchard.my/managed=true` on Cilium policies), so a new object without its label never reaches the
  mirror.
- **Only a live 404 means gone.** Use `readLive` (`engine/consumers/live-object.ts`), which answers
  `present`, `absent` or `unknown`, and never treat `unknown` as `absent`. A row younger than
  `rowMayBePending` may not have its object yet, so it is not drift.
- **Write through the `K8s*Service` layer.** Feature code calls `K8sWorkloadService`,
  `K8sNetworkService`, `K8sNamespaceService` and `K8sCnpgService` in `kubernetes/` instead of making
  its own API client. Writes are server-side apply with field manager `orchard`. A write that must
  survive a failed call goes on `ApplyQueueService.enqueue` with a `dedupeKey`; a newer write for the
  same key replaces the older one. Tenant namespaces are created only with
  `K8sNamespaceService.createNamespace`, which fails closed if the default-deny policy does not
  apply.
- **Adopt edits, don't revert them.** When someone changes an Orchard object with `kubectl`, the
  consumer writes the change back into Orchard's rows. Security objects are the exception: a new
  tenant security object belongs in `engine/guard/desired.ts`, or the guard will not restore it.
- **Live updates go through `OrgEventsService`.** Prisma writes to the watched models (deployment,
  database, project, ingress, build runs and a few more) emit events through `PrismaEventsBridge`.
  Anything else calls `OrgEventsService.emit`, which goes through Redis so every replica sees it;
  `emitLocal` does not. Include `projectId`, or project-restricted members never see the event. An
  `updateMany` without `where.id`, or raw SQL, emits nothing.
- **Gate background work on the lease.** Work for one replica checks
  `LeaderElectionService.isLeader()` (or `onAcquired` for startup work); work every member may do
  checks `LeaseService.canCoordinate`. Never gate on having a kubeconfig.
- **New routes are superadmin-only until decorated.** Use `@Auth()` or `@Public()` from
  `auth/decorators.ts`. Without `@RequireScope`, API tokens need `read` for GET and `deploy` for
  anything else, so a GET must never change state. Authorize in the service with
  `AuthorizationService` (`requireProjectView`, `requireProjectEdit`, `requireOrgMember`,
  `requireOrgAdmin`) before validating input, and answer 404, not 403, when the caller has no access,
  so ids from other tenants look like unknown ids. SSE routes check access with `@SsePreflight`.
- **Stable graft doors never change shape.** Add `name@N+1` beside the old door instead, and keep a
  removed door until its `removeIn` release. Grafts import `@orchardlabs/graft-sdk/server`, never
  `apps/server/src`.
- **Secrets are encrypted and write-only.** A new secret column goes through
  `SecretCryptoService.encryptIfSecret`, and read APIs never return it.

## Generated files

Update these in the same change. CI catches stale routes, docs, doors, the isolation matrix and the
health copy, but nothing catches stale credits. Run `pnpm credits` with the Go version in the
`go.mod` files, or every Go notice file churns.

| When you change                                   | Run                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| An API route                                      | `UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage`, then `pnpm --filter @orchard/contracts bootstrap` and `generate`               |
| Routes, CLI commands, MCP tools or `.env.example` | `pnpm --filter docs generate`                                                                                                               |
| The graft door surface                            | `UPDATE_SNAPSHOT=1 pnpm --filter server test:grafts`                                                                                        |
| A dependency                                      | `pnpm credits`, and fix anything it reports                                                                                                 |
| An API route's access                             | `UPDATE_ISOLATION_MATRIX=1 pnpm --filter server test:isolation:matrix`, then classify the new entries by hand (`docs/isolation-testing.md`) |
| `packages/health/src/health.ts`                   | `pnpm --filter @orchard/health sync`                                                                                                        |

## Conventions

- Commits are Conventional Commits, checked by commitlint in CI, and release-please cuts per-service
  releases from them. Use `feat:`, `fix:` or `chore:`, subject line only. The scope picks the service
  (allowed scopes are in `commitlint.config.cjs`), and an unscoped `feat:` or `fix:` bumps every
  service.
- Migrations: `pnpm --filter server prisma:migrate`. Never hand-write migration SQL or edit an
  applied migration. Migrations run on server boot. `prisma migrate dev` still proposes DROPs for
  tables a graft adopted (`apps/server/prisma/graft-owned.json`); on a real instance those names are
  compat views over `ext_*` tables, so never keep those DROPs. Run `pnpm --filter server
prisma:check-drift` (set `SHADOW_DATABASE_URL`) before committing a migration.
- Typecheck errors claiming a schema column "does not exist" mean a stale generated client, not a
  missing migration. Check `schema.prisma` first, then `pnpm prisma:generate`.
- A URL is server-computed, never assembled client-side. The API returns `url` on every ingress it
  serialises (`scrubIngress`), because an instance may serve on ports other than 80 and 443. A new
  ingress payload selects `host`, `path`, `tlsSecretName` and `entrypoints` and maps through
  `scrubIngress`.
- Kubernetes is the source of truth. A failed read never means a resource is gone; only a live 404
  does.
- Cluster-wide background work gates on a lease or `LeaseService.canCoordinate`, never on having a
  kubeconfig. Otherwise a laptop with a kubeconfig acts as a cluster member.

## Tests

- Most server suites are pure. The ones that write real rows go through
  `apps/server/test/support/test-database.ts`, which refuses `localhost:5432` because that port is
  often a forward to production. Set `TEST_DATABASE_URL` to a throwaway Postgres
  (`apps/server/test/README.md`).
- Never point a local server or test at a production database or kubeconfig to check something.
