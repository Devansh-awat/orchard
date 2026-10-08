# Architecture & service-split roadmap

## Layout principle

- **`apps/*`** — deployable units. Each has a Dockerfile, is versioned
  independently by release-please, and ships a container image.
- **`packages/*`** — shared, imported code. Never deployed.
- **`infra/`** — Helm charts, k8s manifests, Datadog dashboards, cron config.
- **`docs/`** — design notes and this roadmap.

## Today

`apps/server` is a NestJS monolith with ~24 feature modules (`auth`,
`organizations`, `projects`, `quotas`, `kubernetes`, `docker`, `github`,
`ai-chat`, `scim`, `sso`, …). Those module boundaries are the future service
seams.

Design notes for individual subsystems live next to this file. The largest is
[`ai-sandbox.md`](ai-sandbox.md): Greenhouse, the AI dev environment, with its
pluggable sandbox runners (Kubernetes and Vercel), the apply-queue and mirror
pipeline it shares with deployments, terminals, the multiplayer live gateway,
previews and integrations.

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
- `ai-chat` → bursty, isolated deps.
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
