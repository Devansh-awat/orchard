# packages/

Shared, importable code — **never deployed** (that's `apps/`).

First one to add when splitting services: **`contracts/`** — the API DTOs /
shared types both `apps/server` and `apps/frontend` import, so service
boundaries agree on shapes instead of duplicating and drifting.
