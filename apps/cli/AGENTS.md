# orchard CLI: agent guide

This file is for AI coding agents driving the `orchard` binary. Humans should read `README.md` instead.

## What orchard is

Orchard is HackClub's app platform: deployments, databases, domains, scheduled jobs, and logs on Kubernetes. The `orchard` CLI speaks the same `/apiv1` REST API as the web UI and the MCP server, so every platform capability is reachable from this one binary. When stdout is not a TTY (i.e. whenever you run it as a subprocess), it emits JSON on stdout and keeps human status chatter on stderr, so you can pipe it straight into a parser without any flags.

## Auth for headless use

Set a token in the environment and skip login entirely:

```sh
export ORCHARD_API_TOKEN=orch_xxx
```

`ORCHARD_API_TOKEN` overrides any token stored in `~/.orchard/config.json`.

Tokens carry scopes, and each higher scope includes the lower ones (read is a subset of deploy, deploy is a subset of exec):

| scope  | allows                                                              |
| ------ | ------------------------------------------------------------------- |
| read   | GET / HEAD / OPTIONS requests                                       |
| deploy | read, plus every mutation (create, update, delete, scale, restart)  |
| exec   | deploy, plus interactive terminals: `pod exec`, `pod shell`, `db psql` |

Mint a token from an already-authenticated CLI (the secret prints once, default scope read, lifetime capped at 90 days):

```sh
orchard auth token create --name agent --scope deploy --expires-in 30d
orchard auth token create --name ci --scope read --project my-app   # project-restricted
```

Or create one in the web UI under Settings, API Tokens. Interactive humans can also run `orchard auth login` (browser flow) or `orchard auth login --token orch_xxx`.

Other env vars:

| var                  | effect                                                       |
| -------------------- | ------------------------------------------------------------ |
| `ORCHARD_API_URL`    | API base (default `https://orchard.infra.hackclub.com`)      |
| `ORCHARD_API_TOKEN`  | credential, skips login                                      |
| `ORCHARD_JSON=1`     | force JSON output even on a TTY                              |
| `ORCHARD_ORG`        | default org scope (id or slug)                               |
| `ORCHARD_PROJECT`    | default project scope (id or slug)                           |
| `ORCHARD_ENV`        | default environment scope (id or name)                       |

## Output contract

Format resolution, in order: explicit `-o json|table` flag, then `ORCHARD_JSON=1`, then TTY detection (TTY gets tables, a pipe gets JSON).

- Data goes to stdout. Status, progress, and warnings go to stderr. Parse stdout only.
- `orchard events tail` emits NDJSON when piped: one JSON object per line, shaped `{"eventId","type","organizationId","id","projectId","ts","payload"}`.
- `--follow` log commands (`deploy logs -f`, `pod logs -f`, `job-run logs -f`, `observe logs --follow`) stream plain log lines to stdout, one per line, until interrupted (or, for job runs, until the run finishes).
- One-shot log fetches in JSON mode return structured arrays (e.g. `deploy logs` returns `[{"pod","container","logs"}]`).
- On failure in JSON mode, a single error line is printed to stderr:

```json
{"error":{"status":429,"code":6,"message":"..."}}
```

`status` is the HTTP status (0 when the failure was not an API response), `code` is the process exit code.

## Exit codes

| code | meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | success                                              |
| 1    | generic or network error                             |
| 2    | usage error, or a confirmation prompt was refused    |
| 3    | authentication failed (HTTP 401)                     |
| 4    | not found (HTTP 404)                                 |
| 5    | validation or conflict (other HTTP 4xx)              |
| 6    | rate limited (HTTP 429)                              |
| 7    | server error (HTTP 5xx)                              |
| 8    | `--wait` gave up after `--timeout`                   |
| 130  | interrupted (Ctrl-C / SIGTERM)                       |

## Scoping

Most commands need an org, project, or environment scope. Precedence, highest first:

1. flags: `--org`, `--project`, `--env`
2. env vars: `ORCHARD_ORG`, `ORCHARD_PROJECT`, `ORCHARD_ENV`
3. saved context: `orchard use org|project|env <id-or-slug>` (written to `~/.orchard/config.json`)

Values may be ids or slugs (environments: id or name); the CLI resolves them. Inspect or reset the saved context with `orchard context show` / `orchard context clear`. Prefer flags or env vars over `orchard use` when you might share the machine with other sessions: the saved context is global mutable state.

## Pagination

Cursor-paginated lists (`audit list`, `job runs <id>`) take:

- `--limit N` (page size, default 50)
- `--cursor C` (resume from a previous `nextCursor`)
- `--all` (fetch every page, safety-capped at 100 pages)

JSON output includes a `nextCursor` field when more pages remain; pass it back via `--cursor`. Other list commands return the full set in one response.

## --wait / --timeout

Commands that start async work accept `--wait` (block until a terminal state) and `--timeout` (default 10m; hitting it exits 8): `deploy create|scale|restart|rebuild|rollback`, `deploy image set`, `db create`, `db backup create`, `job run`. Without `--wait` they return as soon as the API accepts the request. Progress while waiting goes to stderr; stdout still carries only the data payload.

## Destructive commands and --yes

Delete/revoke/restore style commands ask for confirmation. With stdin or stdout not a TTY the CLI never prompts: it fails immediately with exit 2 unless you pass `--yes` (`-y`). Always pass `--yes` explicitly when you intend a destructive operation.

## Rate limits

The API allows 200 requests per 60 seconds per IP. Exceeding it returns HTTP 429 (exit 6). Do not poll in a tight loop; subscribe instead:

```sh
orchard events tail --types deployment.changed,build.changed
```

`events tail` reconnects automatically and can resume from a known point with `--since-id`.

## Escape hatch: orchard api

Any `/apiv1` endpoint is reachable directly, so you are never blocked on a missing wrapper command:

```sh
orchard api GET /projects
orchard api POST /deployments/<id>/scale --data '{"replicas":3}'
echo '{"replicas":3}' | orchard api POST /deployments/<id>/scale --data -
```

The complete route list (method + path for every endpoint) lives in the repo at `apps/server/test/auth-coverage.snapshot.json`. The MCP tool sources at `apps/server/src/mcp/tools/*.ts` map capabilities to REST paths 1:1.

## Recipes

Deploy from GitHub and wait for it to come up:

```sh
export ORCHARD_PROJECT=my-app
orchard deploy create --name web --github owner/repo#main --port 3000 --wait --timeout 15m
```

Tail logs:

```sh
orchard deploy logs <deploymentId> --follow          # runtime logs, all pods
orchard deploy logs <deploymentId> --build --follow  # build logs
orchard pod logs <podName> -f --tail 200             # one pod
```

Set env vars from a dotenv file:

```sh
orchard env vars set --file .env                 # shared vars on the scoped environment
orchard env vars set STRIPE_KEY=sk_x --secret    # write-only, encrypted at rest
orchard deploy env set <deploymentId> --file .env  # per-deployment vars (pods restart)
```

Run a job and follow it:

```sh
run_id=$(orchard job run <jobId> --wait --timeout 30m | jq -r .id)
orchard job-run logs "$run_id"
```

Subscribe to org events (NDJSON, one event per line):

```sh
ORCHARD_ORG=my-org orchard events tail --types deployment.changed --since-id <lastEventId>
```
