---
title: Code mode for agents
description: Reach the whole Orchard API from an agent without loading 160 tools, with the compact MCP or a script.
---

The full Orchard API is about 450 operations. Describing all of them to a model
up front costs more context than most tasks have, and the
[normal MCP](/mcp/) only covers the common ones even with every toolset on.
There are two ways around that, and neither runs model-written code on Orchard.

| You have                                       | Use                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| A shell (Claude Code, Codex, Cursor, CI)       | The CLI: `orchard api search`, `describe`, and calls by `operationId` |
| No shell (claude.ai, ChatGPT, other chat apps) | The compact MCP at `/compact`                                         |

Both read the same **agent spec**: a trimmed copy of the OpenAPI contract with
every operation's `operationId`, parameters, request and response schemas,
required scope, and two flags. `x-orchard-destructive` marks deletes and
whole-list replaces. `x-orchard-sensitive` marks responses that contain a
secret.

## The spec endpoints

Both are public and served with an `ETag`, so a client can revalidate cheaply:

```
GET https://your-orchard/apiv1/agent-spec.json
GET https://your-orchard/apiv1/openapi.json
```

`agent-spec.json` drops admin, setup, SCIM and sign-in routes, since a token
cannot call them anyway. `openapi.json` is the complete document for other
tooling.

Operation ids are derived from the route: the path words, then a verb.

| Route                           | operationId                |
| ------------------------------- | -------------------------- |
| `GET /deployments`              | `deployments_list`         |
| `GET /deployments/:id`          | `deployments_get`          |
| `GET /deployments/:id/rollout`  | `deployments_rollout_get`  |
| `POST /deployments/:id/restart` | `deployments_restart`      |
| `PUT /deployments/:id/env`      | `deployments_env_set`      |
| `GET /databases/:id/connection` | `databases_connection_get` |

## From a shell: write a script

The CLI caches the spec in `~/.orchard/agent-spec.json` and revalidates it at
most once an hour, so search works offline once it has been fetched.

```sh
orchard api search "deployment logs"
orchard api describe deployments_rollout_get
orchard api deployments_rollout_get -p id=$DEPLOYMENT -q wait=1 -q timeout=120
orchard api deployments_env_set -p id=$DEPLOYMENT -d @env.json --yes
```

`-p` fills path parameters, `-q` adds query parameters, and `-d` takes JSON, a
`@file`, or `-` for stdin. Destructive operations ask for confirmation, and off
a terminal they need `--yes`. The old `orchard api GET /path` form still works.

Output is JSON whenever stdout is not a terminal, so calls chain with `jq`.

Deploy, then wait for it to be live:

```sh
release=$(orchard api deployments_rebuild -p id=$APP | jq -r .releaseId)
orchard api deployments_rollout_get -p id=$APP -q wait=1 -q timeout=120 -q release=$release \
  | jq '{phase, url, hint, error: .build.error}'
```

Find every crashing deployment in a project and say why:

```sh
orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id' |
while read -r id; do
  orchard api deployments_rollout_get -p id=$id |
    jq -c --arg id "$id" 'select(.phase == "crashing" or .phase == "build_failed")
      | {id: $id, phase, hint, failing: [.pods.failing[]? | {pod, reason, exitCode}]}'
done
```

Set one variable on every deployment in a project, keeping the rest:

```sh
for id in $(orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id'); do
  orchard api deployments_get -p id=$id |
    jq '{env: ([.envVars[] | {key, value, secret}] | map(select(.key != "LOG_LEVEL"))
         + [{key: "LOG_LEVEL", value: "info"}])}' |
    orchard api deployments_env_set -p id=$id -d - --yes
done
```

Secret values read back as `null`, and sending `null` keeps the stored value,
so this round trip never needs to know a secret.

The same thing in Node, using the token the CLI already uses:

```js
const base = process.env.ORCHARD_API_URL ?? 'https://orchard.infra.hackclub.com';
const headers = { Authorization: `Bearer ${process.env.ORCHARD_API_TOKEN}` };
const api = (path) => fetch(`${base}/apiv1${path}`, { headers }).then((r) => r.json());

const deployments = await api(`/projects/${process.env.PROJECT}/deployments`);
for (const d of deployments) {
  const rollout = await api(`/deployments/${d.id}/rollout`);
  if (!['live', 'stopped'].includes(rollout.phase))
    console.log(d.name, rollout.phase, rollout.hint);
}
```

The API allows 600 requests a minute per token. Prefer `wait=1` on the rollout
endpoint over polling it.

## Without a shell: the compact MCP

Point the client at `/compact` on the MCP host instead of `/`:

```sh
claude mcp add --transport http orchard-compact https://mcp.your-orchard-domain/compact
```

Authentication is identical to the normal MCP: OAuth with `mcp:read`,
`mcp:deploy` or `mcp:exec`, or an `orch_` token. The whole tool list is about
800 tokens:

| Tool                 | Does                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `search_api`         | Ranks operations against a few keywords; returns ids, paths and flags       |
| `describe_operation` | The full contract for one operation, by `operationId` or `"GET /path"`      |
| `call_api`           | Runs one operation as you: `pathParams`, `query`, `body`, optional `fields` |

`call_api` has three guard rails:

- **Destructive operations** refuse to run unless `confirm` is set to the
  operation's own id. The model has to ask, then repeat the id back.
- **`fields`** keeps only the dotted paths you list (`["items.id","items.status"]`),
  through arrays and objects, so a large response does not flood the context.
- **Output over 24,000 characters** is cut off with a note telling the model to
  narrow the request with `fields`.

Results from operations flagged `x-orchard-sensitive` carry
`_meta: { "orchard/sensitive": true }`. Operations that need a wider scope than
the connection has are refused with a message naming the scope to reconnect
with.

The tradeoff against a code-execution sandbox is round trips: each call is a
turn for the model. In exchange the whole API is reachable for a fixed, small
context cost, and nothing the model writes ever executes on Orchard.

The local stdio server serves the compact tools with `ORCHARD_MCP_MODE=compact`.
