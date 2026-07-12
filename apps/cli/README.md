# orchard cli

Command-line interface for the Orchard platform. Speaks the same `/apiv1` REST
API as the web UI and the MCP server, so every capability is reachable here.

Output is **pretty in a terminal** and **JSON when piped** (or with
`--output json`) — equally useful for humans and AI agents.

## Build

```sh
go build -o orchard .
# or install onto PATH
go install github.com/LeafdTK/leaf/cli@latest
```

## Auth

```sh
orchard auth login            # browser flow (default)
orchard auth status
orchard auth logout
```

**Browser flow (default):** opens the Orchard web app, which — using your
existing session — mints a personal `orch_` API token and hands it back to the
CLI over a one-shot `127.0.0.1` callback. A random `state` is checked to prevent
CSRF, and the callback host is always loopback (only the port is dynamic). This
relies on the `/cli/auth` bridge page in the frontend.

Why not MCP OAuth? The MCP provider issues `type:'mcp'` JWTs that the first-party
`/apiv1` guard deliberately rejects (the M-2 invariant). The CLI talks to
`/apiv1` directly, so it needs a real session-or-`orch_` credential — which is
exactly what this flow produces.

**Manual / headless:**

```sh
orchard auth login --token orch_xxx     # paste a token
orchard auth login --with-token         # prompt for one
orchard auth login --no-browser         # print the URL instead of opening it
ORCHARD_API_TOKEN=orch_xxx orchard …    # skip login entirely (agents/CI)
```

Config lives at `~/.orchard/config.json`. Overridable via env:

- `ORCHARD_API_URL` — API base (default `https://orchard.infra.hackclub.com`)
- `ORCHARD_API_TOKEN` — token (skips `auth login`, good for CI/agents)
- `ORCHARD_JSON=1` — force JSON output even on a TTY

## Commands

```
orchard auth login|status|logout
orchard use org|project|env <id-or-slug>   # save default scope
orchard context show|clear
orchard project list|get
orchard deploy list|get|scale|restart|rebuild|logs
orchard db list|get
orchard ui                       # interactive dashboard (bubbletea)
orchard api <METHOD> <path>      # raw escape hatch — full API parity
```

Global flags: `--org/--project/--env` (id or slug, override the saved
context; also via `ORCHARD_ORG/PROJECT/ENV`), `--yes/-y` (skip confirmation
prompts — required for destructive commands when stdin is not a TTY; the CLI
never blocks waiting for input in a pipe), `-o json|table`.

## Exit codes

`0` ok · `1` generic/network · `2` usage or refused prompt · `3` auth ·
`4` not found · `5` validation/conflict · `6` rate limited · `7` server error ·
`8` --wait/--timeout deadline · `130` interrupted. With `-o json` (or piped),
errors print as one-line JSON to stderr:
`{"error":{"status":429,"code":6,"message":"…"}}`.

The `api` command reaches **any** endpoint, so the CLI has complete coverage
before a friendly wrapper exists:

```sh
orchard api GET /projects
orchard api POST /deployments/abc/scale --data '{"replicas":3}'
echo '{"replicas":3}' | orchard api POST /deployments/abc/scale --data -
```

## Layout

```
main.go                      entry point
cmd/                         cobra commands (one file per resource)
internal/api/client.go       Bearer-auth REST client (mirrors mcp/client.ts)
internal/config/config.go    ~/.orchard/config.json + env overrides
internal/output/output.go    TTY detection, json/table rendering, styles
internal/tui/tui.go          bubbletea dashboard
```

## Adding a command

1. Add a `*cobra.Command` in the relevant `cmd/<resource>.go`.
2. Call `client()` for an authenticated client.
3. For reads: decode into `any`, branch on `fmtFlag()` — `output.JSON` vs
   `output.Table` (use `asList`/`pick` for schema-flexible rendering).
4. For writes: `cl.Send(method, path, body, nil)` then `output.Successf(...)`.

Endpoint reference: `server/src/mcp/tools/*.ts` maps each capability to its REST
path 1:1.
