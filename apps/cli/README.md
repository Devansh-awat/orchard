# orchard cli

Command-line interface for the Orchard platform. Speaks the same `/apiv1` REST
API as the web UI and the MCP server, so every capability is reachable here.

Output is **pretty in a terminal** and **JSON when piped** (or with
`--output json`), equally useful for humans and AI agents.

## Install

Homebrew (macOS):

```sh
brew tap leafdtk/tap
brew install --cask orchard-cli
```

The cask is `orchard-cli` because homebrew core already owns the name
`orchard` (an unrelated containers GUI); the installed binary is still
`orchard`.

Prebuilt binaries for macOS/Linux/Windows live on the public
[orchard-releases](https://github.com/LeafdTK/orchard-releases/releases) repo.
Installer:

```sh
curl -fsSL https://raw.githubusercontent.com/LeafdTK/orchard-releases/main/install.sh | sh
```

From a clone of the repository, in `apps/cli`:

```sh
go build -o orchard .
```

## Auth

```sh
orchard auth login            # browser flow (default)
orchard auth status
orchard auth logout
```

**Browser flow (default):** opens the Orchard web app, which, using your
existing session, mints a personal `orch_` API token and hands it back to the
CLI over a one-shot `127.0.0.1` callback. A random `state` is checked to prevent
CSRF, and the callback host is always loopback (only the port is dynamic). This
relies on the `/cli/auth` bridge page in the frontend.

Why not MCP OAuth? The MCP provider issues `type:'mcp'` JWTs that the first-party
`/apiv1` guard deliberately rejects (the M-2 invariant). The CLI talks to
`/apiv1` directly, so it needs a real session-or-`orch_` credential, which is
exactly what this flow produces.

**Manual / headless:**

```sh
orchard auth login --token orch_xxx     # paste a token
orchard auth login --with-token         # prompt for one
orchard auth login --no-browser         # print the URL instead of opening it
ORCHARD_API_URL=https://orchard.example.com ORCHARD_API_TOKEN=orch_xxx orchard ...  # skip login entirely (agents/CI)
```

`--no-browser` still finishes through a callback to a random port on `localhost`,
so on a remote box the browser's machine has to reach it. The command prints the
port and the tunnel to open from that machine:

```sh
ssh -L <port>:127.0.0.1:<port> <remote-host>
```

Without a terminal there is nobody to ask which instance you mean, so pass
`--api-url <url>` or set `ORCHARD_API_URL` as well.

Tokens carry scopes (`read`, `deploy`, `exec`; each includes the previous) and
live at most 90 days. Mint and manage them from the CLI:

```sh
orchard auth token create --name ci --scope deploy --expires-in 30d
orchard auth token list
orchard auth token revoke <tokenId>
```

Config lives at `~/.orchard/config.json`, one context per Orchard instance
(URL, token and `orchard use` scope). `orchard auth login --api-url <url>`
adds a context; `orchard context list|use|rename|remove` manages them and
`--context <name>` picks one for a single command. Overridable via env:

- `ORCHARD_CONTEXT`: context to use instead of the current one

- `ORCHARD_API_URL`: API base. There is no built-in default, so set it wherever no context is saved
- `ORCHARD_API_TOKEN`: token (skips `auth login`, good for CI/agents)
- `ORCHARD_JSON=1`: force JSON output even on a TTY
- `ORCHARD_ORG` / `ORCHARD_PROJECT` / `ORCHARD_ENV`: default scope

## Quickstart

```sh
orchard auth login
orchard import owner/repo             # project + build + deploy + URL in one shot
orchard link --project my-app         # or: bind this directory to a project
orchard up                            # deploy the current directory
orchard open                          # open the app in your browser
orchard deploy logs <deploymentId> --follow
orchard env pull                      # write vars to .env.orchard
orchard pod shell <podName>           # interactive shell (exec-scope token)
```

Deployments created with a port get a generated `https://` URL on the platform
domain automatically, protected by org-member auth until you make it public
(disable with `--auto-url=false`).

## Commands

Grouped as in `orchard --help`. Run `orchard <command> --help` for flags and
subcommands.

**Core**

```
orchard auth        login | status | logout | token list|create|revoke |
                    session list|revoke|revoke-all
orchard use         <org|project|env> <id-or-slug>     save default scope
orchard link        [--status] / orchard unlink        per-directory scope
                    (.orchard/project.json, gitignored; wins over `use`)
orchard up          [dir]                              deploy the directory
orchard import      <owner/repo[#branch]>              one-shot GitHub import
orchard open        [deployment] [--dash]              open the app URL
orchard context     show | clear
orchard claude      import | list | remove             your Claude Code setup
orchard events      tail                               live org events (SSE)
orchard overview                                       org dashboard at a glance
orchard invitation  list | accept | decline | accept-all
orchard user        profile | update | avatar set | delete
orchard ui                                             interactive dashboard (TUI)
```

**Resources**

```
orchard org         list | get | update | avatar set | delete |
                    backup-settings get|set
orchard project     list | get | create | update | delete | sync |
                    icon set | background set |
                    member list|add|remove|set-role | invitation revoke
orchard env         list | get | create | delete | set-default |
                    vars get|set|unset | pull
orchard deploy      list | get | create | delete | scale | restart | rebuild |
                    cancel | rollback | logs | pods | metrics |
                    image set | history | killed list|logs |
                    auto-deploy status|enable|disable |
                    webhook-token list|create|delete | github-deployments |
                    env get|set|unset | resources get|set | volumes get|set |
                    strategy set | health-check set | build-root set
orchard db          list | get | create | delete | connection | metrics |
                    logs | psql | extension list|install|uninstall |
                    settings get|set | public enable|disable |
                    resources set | storage expand |
                    backup list|create|restore | backup-schedule get|set|clear |
                    fork | recovery | diagnose | activity | protect |
                    checkpoint create|list|group|restore|restore-group|rm |
                    ops list|get|cancel|undo | test-backup run|list |
                    trash list|restore | pooler get|set |
                    replication get|set | user list|create|rm |
                    versions | security | upgrade
orchard pod         list | get | logs | delete | exec | shell
orchard sandbox     create | list | get | update | start | stop | delete |
                    ssh | ssh-config | chat | credentials set|clear|status
orchard ssh-identity list | add | remove | import-github
orchard service     list | create | update | delete | exposure set |
                    port public enable|disable
orchard domain      list | get | create | update | delete |
                    protection get|set | validate-dns
orchard job         list | get | create | update | pause | resume | delete |
                    steps set | run | runs
orchard job-run     get | cancel | logs
orchard template    list | get | deploy | instance list|get|delete |
                    admin create|update|delete
orchard compose     list | get | deploy | redeploy |
                    auto-deploy enable|disable | delete
orchard webhook     deploy <token>                     trigger a deploy webhook
orchard observe     overview | logs | http | errors | runtime | capabilities
orchard member      list | invite | remove | set-role |
                    invites list|cancel|resend
orchard notify      channel list|create|update|delete|test|deliveries
orchard audit       list
orchard quota       show | me | members | projects
orchard doctor      [--selftest]  (superadmin)
```

**Utility**

```
orchard api         <METHOD> <path> [--data JSON|-]    raw escape hatch
orchard github      status | link | unlink | install | installations | repos |
                    branches | dockerfiles | dockerfile-info | contents
orchard tailscale   status | link | unlink | get | expose | unexpose
orchard completion  <shell>                            shell autocompletion
orchard help        [command]
```

Async operations take `--wait/--timeout` (default 10m; exceeding it exits 8).
Destructive ones require `--yes` when piped; the CLI never blocks waiting for
input in a pipe. Cursor-paginated lists (`audit list`, `job runs`) take
`--limit/--cursor/--all`. Interactive terminals (`pod exec`, `pod shell`,
`db psql`) run over a websocket and need an exec-scope token.

The `api` command reaches **any** endpoint, so the CLI has complete coverage
before a friendly wrapper exists:

```sh
orchard api GET /projects
orchard api POST /deployments/abc/scale --data '{"replicas":3}'
echo '{"replicas":3}' | orchard api POST /deployments/abc/scale --data -
```

## Global flags

- `--org / --project / --env`: scope by id or slug; overrides the saved
  context (also via `ORCHARD_ORG/PROJECT/ENV`; precedence is flag, then env
  var, then the directory link written by `orchard link`, then `orchard use`
  context)
- `--yes / -y`: skip confirmation prompts (required for destructive commands
  when stdin is not a TTY)
- `-o, --output json|table`: force the output format (default: auto by TTY)
- `--version`: print the CLI version (same as `orchard version`)

## Exit codes

`0` ok, `1` generic/network, `2` usage or refused prompt, `3` auth,
`4` not found, `5` validation/conflict, `6` rate limited, `7` server error,
`8` --wait/--timeout deadline, `130` interrupted. With `-o json` (or piped),
errors print as one-line JSON to stderr:
`{"error":{"status":429,"code":6,"message":"..."}}`.

## AI agents

Running `orchard` from an agent or a script? Read [AGENTS.md](./AGENTS.md):
it documents the output contract (JSON/NDJSON, stdout vs stderr), scoping,
pagination, rate limits, and copy-paste recipes. A Claude skill wrapping the
same material lives at [skill/SKILL.md](./skill/SKILL.md).

## TUI

`orchard ui` (aliases: `dash`, `tui`) launches an interactive bubbletea
dashboard for browsing projects, deployments, and databases. It requires a
real terminal; there is no non-interactive mode (that's what the JSON output
is for).

## Development

```sh
go build -o orchard .
go test ./...
```

Layout:

```
main.go                      entry point
cmd/                         cobra commands (one file per resource)
internal/api/client.go       Bearer-auth REST client (mirrors mcp/client.ts)
internal/config/config.go    ~/.orchard/config.json + env overrides
internal/output/output.go    TTY detection, json/table rendering, styles
internal/exitcode/           error -> stable exit code mapping
internal/tui/tui.go          bubbletea dashboard
```

Adding a command:

1. Add a `*cobra.Command` in the relevant `cmd/<resource>.go`.
2. Call `client()` for an authenticated client.
3. For reads: decode into `any`, branch on `fmtFlag()`, `output.JSON` vs
   `output.Table` (use `asList`/`pick` for schema-flexible rendering).
4. For writes: `cl.Send(method, path, body, nil)` then `output.Successf(...)`.

Endpoint reference: `apps/server/src/mcp/tools/*.ts` maps each capability to
its REST path 1:1, and `apps/server/test/auth-coverage.snapshot.json` lists
every route the server exposes.
