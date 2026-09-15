# @orchard/contracts

The shared API contract for Orchard. This is the package `docs/ARCHITECTURE.md`
calls the prerequisite for any service split: the shapes that cross the wire
live here, and both `apps/server` and `apps/frontend` import them instead of
duplicating and drifting.

## Layout

- `src/routes.generated.ts` — the full route list (`method`, `path`, `auth`),
  emitted mechanically from `apps/server/test/auth-coverage.snapshot.json`.
  Never edit by hand.
- `src/schemas/*.ts` — per-domain attachment maps (`deployments`, `databases`,
  `jobs`, `events`, `common`). Each exports an `attachments` record keyed by
  `"METHOD /path"` (exactly as it appears in the snapshot, express-style
  `:param` placeholders) whose values are
  `{ request?: ZodTypeAny; response?: ZodTypeAny; summary?: string; scope?: 'read' | 'deploy' | 'exec' }`.
- `src/schemas/index.ts` — merges the domain maps. Stable on purpose: domain
  work only ever touches its own `src/schemas/<domain>.ts`, never this file,
  `registry.ts`, or another domain's file.
- `src/registry.ts` — merges `routes.generated.ts` with the attachments into
  the typed `registry` array. This is the package's main export.
- `src/generate.ts` — builds `openapi.json` (OpenAPI 3.1) from the registry.
- `openapi.json` — the generated spec, committed at the package root.

## Attaching schemas

Pick the domain file, add an entry keyed by `"METHOD /path"`:

```ts
import { z } from 'zod';
import type { RouteAttachment } from '../types';

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'POST /deployments/:deploymentId/services': {
    summary: 'Create a service for a deployment',
    request: z.object({ name: z.string(), port: z.number().int() }),
    response: z.object({ id: z.string() })
  }
};
```

`request` becomes the JSON request body on `POST`/`PUT`/`PATCH`; on `GET` and
`DELETE` a `ZodObject` request is treated as query parameters. `response` is
the 200 body. Routes without attachments still appear in the spec with generic
object request/response, an auth description, and a tag derived from the first
path segment.

## Commands

```sh
pnpm --filter @orchard/contracts generate
```

Regenerates `openapi.json` deterministically (recursively sorted keys), so a
clean `git diff` after running it means the spec is up to date.

## Adding routes

Routes are never added to this package by hand. When `apps/server` gains or
changes endpoints, the auth-coverage snapshot changes with it (that's enforced
by the server's auth-coverage test), and the route list here is re-derived
from the snapshot:

```sh
pnpm --filter @orchard/contracts bootstrap
pnpm --filter @orchard/contracts generate
```

`bootstrap` rewrites `src/routes.generated.ts` from
`apps/server/test/auth-coverage.snapshot.json`; commit both regenerated files.
