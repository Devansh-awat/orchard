# Architecture & service-split roadmap

## Layout principle

- **`apps/*`** — deployable units. Each has a Dockerfile, is versioned
  independently by release-please, and ships a container image.
- **`packages/*`** — shared, imported code. Never deployed.
- **`infra/`** — Helm charts, k8s manifests, Datadog dashboards, cron config.
- **`docs/`** — design notes and this roadmap.

## Today

`apps/server` is a NestJS monolith with feature modules (`auth`,
`organizations`, `projects`, `quotas`, `kubernetes`, `docker`, `github`,
`scim`, `sso`, …). Those module boundaries are the future service
seams.

Design notes for individual subsystems live next to this file. The largest is
[`ai-sandbox.md`](ai-sandbox.md): Greenhouse, the AI dev environment, with its
pluggable sandbox runners (Kubernetes and Vercel), the apply-queue and engine
pipeline it shares with deployments, terminals, the multiplayer live gateway,
previews and integrations.

## Orchard Engine

Kubernetes is the source of truth. The engine (`apps/server/src/engine`) keeps a
Postgres copy of every object Orchard manages (`k8s_objects`) and hands each
change to a consumer, which adopts what someone changed with `kubectl` into
Orchard's own rows instead of reverting it. Security objects (default-deny
network policies, Cilium auth, the disk write-guard) are the one exception: the
`guard` shard puts Orchard's version back and audits it.

- **`engine/core`** is the standalone part: the list-then-watch informer,
  tombstoned deletes, lease election, health. It imports nothing from the server
  (only `@kubernetes/client-node`), which oxlint enforces, and talks to storage
  through the `EngineStore` interface (`engine/prisma-store.ts` is the Postgres
  one). It stays under `apps/server` so release-please and the server image
  ship it with the server.
- **`engine/consumers`** are Orchard-specific: one per kind, wired up in
  `engine/shards.ts`. Grafts add shards through the kube door
  (`registerEngineShard`).
- **Nothing is ever removed on an error.** Only a live read answering 404 means
  an object is gone; anything else means "unknown" and the consumer throws so the
  engine retries. Removals that destroy Orchard state are confirmed twice, 90s
  apart, and capped by a breaker.
- **Adoption never echoes Orchard's own writes.** Consumers defer while a build
  or a queued apply is in flight, and fields Orchard derives itself (env,
  CronJob schedules, `shared_buffers`) carry an annotation recording what Orchard
  last wrote, so only a value that differs from it counts as an outside edit.

## Splitting into services

**Prerequisite — `packages/contracts`.** Before carving a module out, the
shapes that cross the wire must live in a shared package both sides import
(DTOs, event payloads, or an OpenAPI-generated client). Otherwise every split
duplicates types and they drift.

1. Create `packages/contracts`; move the request/response/event types there.
2. Migrate `apps/server` and `apps/frontend` to import from it.
3. Extracting a module → `apps/<service>` is then mechanical — it still imports
   `@orchard/contracts`.

**Suggested first cuts** (by blast radius / scaling profile, not alphabetically):

- `kubernetes` + `docker` → a builder/deployer service (heavy, async).
- `github` (webhooks) → event-ingest edge.
- Keep `auth` · `organizations` · `projects` · `quotas` together as the core
  API — they're welded by RBAC.

**Communication.** There's already a Go `gateway` and an `events` module — lean
into event-driven (a queue) for the async work (builds, webhooks) and keep
sync HTTP for the core API. Define event payloads in `packages/contracts` too.

## What a folder move touches

When moving or splitting, budget for: Dockerfile `COPY`/`-f` paths, the GitHub
Actions `paths:` filters + dockerfile inputs, `release-please-config.json`
package paths + `.release-please-manifest.json` keys (keep `component` stable so
tags stay `<service>/vX`), `pnpm-workspace.yaml` globs, and Helm `values.yaml`
image refs.
