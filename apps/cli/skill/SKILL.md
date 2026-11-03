---
name: orchard-cli
description: Deploy and manage apps, databases, scheduled jobs, domains, and logs on Orchard, a self-hostable app platform, via the orchard CLI. Use when deploying from GitHub or an image, scaling or restarting deployments, tailing logs, managing env vars, running jobs, creating databases, or scripting against the Orchard API.
---

# orchard CLI

`orchard` drives an Orchard instance over the same `/apiv1` REST API as the web UI. Full agent contract: `AGENTS.md` next to this skill (apps/cli/AGENTS.md in the repo).

## Setup

- Auth: `export ORCHARD_API_TOKEN=orch_xxx` (mint via `orchard auth token create --name x --scope deploy --expires-in 30d`, or web Settings, API Tokens). Scopes nest: read < deploy < exec (exec covers `pod exec/shell`, `db psql`).
- Scope: flags `--org/--project/--env` beat env vars `ORCHARD_ORG/PROJECT/ENV`, which beat the saved `orchard use ...` context. Values are ids or slugs.

## Output and exit codes

- Piped output is JSON on stdout; status lines go to stderr. `ORCHARD_JSON=1` or `-o json` forces it.
- `events tail` emits NDJSON; `--follow` log commands stream plain lines, except piped `observe logs --follow`, which emits JSON entries.
- Errors in JSON mode: one stderr line `{"error":{"status":<http>,"code":<exit>,"message":"..."}}`.
- Exit codes: 0 ok, 1 generic, 2 usage/refused prompt, 3 auth, 4 not found, 5 validation, 6 rate limited, 7 server, 8 wait timeout, 9 deploy-failed (build failed), 10 deploy-crashing (pods crashing or rollout unhealthy), 130 interrupted.

## Rules

- Destructive commands (delete/revoke/restore) need `--yes` when not a TTY; the CLI never prompts in a pipe (it exits 2 instead).
- Async ops (`deploy create|scale|start|restart|rebuild|rollback`, `deploy image set`, `up`, `import`, `db create`, `db backup create|restore`, `db fork`, `db checkpoint restore`, `db ops get`, `db test-backup run`, `db trash restore`, `db upgrade`, `job run`) take `--wait --timeout 10m`; deadline exits 8. `db diagnose <id>` explains database health and exits 10 when it is down. `db versions` lists Postgres majors; `db security <id>` lists CVEs and the fix; `db upgrade <id> --to <major> --yes` takes Postgres offline for the in-place step.
- Paginated lists (`audit list`, `job runs`) take `--limit/--cursor/--all`; JSON includes `nextCursor`.
- Rate limit is 600 req/60s per `orch_` token (200 req/60s per IP otherwise); 429s carry `Retry-After`. Prefer `--wait` (server long-poll) or `orchard events tail --types ...` over polling.
- Anything without a wrapper: `orchard api METHOD /path [--data JSON|-]`. Route list: `apps/server/test/auth-coverage.snapshot.json`.

## Rollout flow

- Deployment `--wait` long-polls `GET /deployments/:id/rollout` until a terminal phase: `live`/`stopped` exit 0, `build_failed` exits 9, `crashing`/`unhealthy` exit 10. `unhealthy` (new pods failing, old ones serving) is a failure.
- On failure stderr gets `build.error` or each failing pod's reason plus a log tail. In JSON mode stdout gets `{deploymentId, releaseId, phase, url, build, pods, hint}`, also on exit 9/10.
- `orchard deploy status <id>` answers "is it live, and if not why" once; `orchard up` waits by default when piped and keeps build logs on stderr in JSON mode.
- Mutations return `rolloutSince`/`releaseId`; the CLI pins the wait to them so a restart can't read `live` off old pods.
- Retrying a mutation after a timeout: reuse `ORCHARD_IDEMPOTENCY_KEY=<stable value>` for that command so the server replays instead of redoing it. `deploy rollback <id>` with no history id goes to the previous image.

## Common commands

```sh
orchard deploy create --name web --github owner/repo#main --port 3000 --wait
orchard up --wait -o json | jq -r .url       # local dir; exit 9 build failed, 10 crashing
orchard deploy status <id>                   # phase + why; --wait to block
orchard deploy rollback <id> --yes --wait    # back to the previous release
orchard logs <id> -f                         # --build for build logs
orchard env pull -o json                     # [{key, value, secret}], secrets value null
orchard deploy scale <id> 3 --wait
orchard env vars set --file .env             # --secret for write-only vars
orchard deploy env set <id> KEY=VAL          # per-deployment, pods restart
orchard db create --name pg --wait && orchard db connection <id>
run_id=$(orchard job run <jobId> --wait | jq -r .id); orchard job-run logs "$run_id"
orchard events tail --types deployment.changed,build.changed
```

## Write a script

Discover and call any operation by id (spec cached in `~/.orchard/agent-spec.json`, works offline once fetched):

```sh
orchard api search "deployment logs" -o json | jq -r '.[0].operationId'
orchard api describe deployments_rollout_get          # params, schemas, scope, destructive/sensitive
orchard api deployments_rollout_get -p id=<uuid> -q wait=1 -q timeout=120
orchard api deployments_env_set -p id=<uuid> -d @env.json --yes   # destructive: --yes off a TTY
```

Chain with jq, e.g. every crashing deployment in a project:

```sh
for id in $(orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id'); do
  orchard api deployments_rollout_get -p id=$id | jq -c --arg id $id 'select(.phase=="crashing" or .phase=="build_failed") | {id:$id,phase,hint}'
done
```

`-p` path params, `-q` query params, `-d` JSON / `@file` / `-`. `orchard api METHOD /path` still works.
