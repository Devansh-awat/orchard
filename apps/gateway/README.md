# Dev gateway

Tiny Go reverse proxy that lets the SvelteKit frontend and the Nest backend
share an origin during development. Replaces the previous `docker compose up`
nginx container.

Started automatically by `pnpm run dev` (the workspace root invokes it
alongside `frontend` and `server`).

## Routing

- `/apiv1/*` → `http://localhost:3001` (Nest)
- everything else → `http://localhost:3000` (Vite/SvelteKit)

## Defaults

- Listen: `:4000` (override with `GATEWAY_LISTEN` or `--listen`)
- Backend: `http://localhost:3001` (`GATEWAY_BACKEND` / `--backend`)
- Frontend: `http://localhost:3000` (`GATEWAY_FRONTEND` / `--frontend`)

Open `http://localhost:4000` once the dev script reports the gateway is
listening.

## Why Go

- One binary, no Docker.
- `httputil.ReverseProxy` with `FlushInterval = -1` streams SSE
  (`/apiv1/events/orgs/:id`) without buffering.
- Native `Connection: Upgrade` passthrough handles the Kubernetes terminal
  WebSocket without extra wiring.

## Standalone use

If you don't want pnpm to manage it:

```sh
cd apps/gateway
go run .
```
