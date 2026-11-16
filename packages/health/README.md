# @orchard/health

Decides how healthy an app is. `computeHealth` takes a deployment's pods, replica count and rollout
and returns the app state, the deploy state, the serving count and a list of problems, each with a
title and a hint. `isQuotaFailure` and `quotaHint` explain a rollout that a resource quota blocked.

The dashboard and the server must say the same thing about the same app, so both use this one file:

- The frontend imports `src/health.ts` through the `$health` alias in `apps/frontend/svelte.config.js`.
- The server keeps a copy at `apps/server/src/health/health.generated.ts`, written by
  `scripts/sync.ts`.

The package is never published or deployed on its own. It ships inside the frontend and server.

## Changing it

Edit `src/health.ts`, then sync the server copy:

```bash
pnpm --filter @orchard/health sync
```

Never edit the server copy by hand. `test/health-sync.test.ts` in the server fails when the two drift,
and CI runs it:

```bash
pnpm --filter server exec tsx --test test/health-sync.test.ts
```

## Tests

The unit tests in `test/` run as part of the frontend suite:

```bash
pnpm --filter frontend test
```

To run only these:

```bash
pnpm --filter @orchard/health test
```
