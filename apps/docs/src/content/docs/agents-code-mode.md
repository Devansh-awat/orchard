---
title: Code mode for agents
description: Call the whole Orchard API from an agent with the orchard CLI or the compact MCP server, without loading every MCP tool into context.
---

To reach any Orchard API operation from an agent, use the CLI or the compact MCP server. Describing every operation to a model uses more context than most tasks have, and the [normal MCP server](/mcp/) does not cover every operation.

| Your agent has                                     | Use                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| A shell, such as Claude Code, Codex, Cursor or CI  | The CLI: `orchard api search`, `describe`, and calls by `operationId`. |
| No shell, such as claude.ai or another chat app    | The compact MCP server at `/compact`.                                 |

Neither option runs model-written code on Orchard.

## The agent spec

Both options read the agent spec, a trimmed copy of the OpenAPI contract. For each operation, the spec has the `operationId`, parameters, request and response schemas, required scope and two flags:

- `x-orchard-destructive` marks deletes, whole-list replacements and other operations that remove or overwrite state.
- `x-orchard-sensitive` marks responses that contain a secret.

Both spec files are public and served with an `ETag`:

```txt
GET https://orchard.example.com/apiv1/agent-spec.json
GET https://orchard.example.com/apiv1/openapi.json
```

`agent-spec.json` leaves out admin, setup, SCIM, SSO and sign-in routes. `openapi.json` is the complete document.

Operation IDs come from the route: the path words, then a verb.

| Route                           | `operationId`              |
| ------------------------------- | -------------------------- |
| `GET /deployments`              | `deployments_list`         |
| `GET /deployments/:id`          | `deployments_get`          |
| `GET /deployments/:id/rollout`  | `deployments_rollout_get`  |
| `POST /deployments/:id/restart` | `deployments_restart`      |
| `PUT /deployments/:id/env`      | `deployments_env_set`      |
| `GET /databases/:id/connection` | `databases_connection_get` |

## Call the API from a shell

The CLI caches the spec in `~/.orchard/agent-spec.json` and revalidates it at most once an hour. Search works offline after the first fetch.

```bash
orchard api search "deployment logs"
orchard api describe deployments_rollout_get
orchard api deployments_rollout_get -p id=$DEPLOYMENT -q wait=1 -q timeout=120
orchard api deployments_env_set -p id=$DEPLOYMENT -d @env.json --yes
```

| Flag     | Purpose                                         |
| -------- | ----------------------------------------------- |
| `-p`     | Fills a path parameter.                         |
| `-q`     | Adds a query parameter.                         |
| `-d`     | Sends a JSON body, a `@file`, or `-` for stdin. |
| `--yes`  | Confirms a destructive operation without a terminal. |

`orchard api GET /path` also works, and does not use the spec. Output is JSON when stdout is not a terminal.

### Deploy and wait until the app is live

```bash
release=$(orchard api deployments_rebuild -p id=$APP | jq -r .releaseId)
orchard api deployments_rollout_get -p id=$APP -q wait=1 -q timeout=120 -q release=$release \
  | jq '{phase, url, hint, error: .build.error}'
```

### Find crashing deployments in a project

```bash
orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id' |
while read -r id; do
  orchard api deployments_rollout_get -p id=$id |
    jq -c --arg id "$id" 'select(.phase == "crashing" or .phase == "build_failed")
      | {id: $id, phase, hint, failing: [.pods.failing[]? | {pod, reason, exitCode}]}'
done
```

### Set one variable on every deployment in a project

Secret values read back as `null`. Sending `null` keeps the stored value, so this script does not need to know any secret.

```bash
for id in $(orchard api projects_deployments_list -p id=$PROJECT | jq -r '.[].id'); do
  orchard api deployments_get -p id=$id |
    jq '{env: ([.envVars[] | {key, value, secret}] | map(select(.key != "LOG_LEVEL"))
         + [{key: "LOG_LEVEL", value: "info"}])}' |
    orchard api deployments_env_set -p id=$id -d - --yes
done
```

### Call the API from Node.js

```js
const base = process.env.ORCHARD_API_URL;
const headers = { Authorization: `Bearer ${process.env.ORCHARD_API_TOKEN}` };
const api = (path) => fetch(`${base}/apiv1${path}`, { headers }).then((r) => r.json());

const deployments = await api(`/projects/${process.env.PROJECT}/deployments`);
for (const d of deployments) {
  const rollout = await api(`/deployments/${d.id}/rollout`);
  if (!['live', 'stopped'].includes(rollout.phase))
    console.log(d.name, rollout.phase, rollout.hint);
}
```

The API allows 600 requests a minute for each token. Use `wait=1` on the rollout endpoint instead of polling.

## Connect the compact MCP server

Point the client at `/compact` on the MCP host:

```bash
claude mcp add --transport http orchard-compact https://mcp.example.com/compact
```

Authentication works the same as the normal server. Use OAuth with `mcp:read`, `mcp:deploy` or `mcp:exec`, or an `orch_` token. For more information, refer to [Connect an MCP client](/mcp/).

The server has three tools:

| Tool                 | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `search_api`         | Finds operations by keyword. Returns IDs, paths and flags, best match first. |
| `describe_operation` | Returns the full contract for one `operationId` or `"METHOD /path"`.        |
| `call_api`           | Runs one operation as you, with `pathParams`, `query`, `body` and `fields`. |

`call_api` has the following limits:

- **Destructive operations.** The call fails unless `confirm` is set to the `operationId`.
- **`fields`.** The response keeps only the dotted paths that you list, such as `["items.id","items.status"]`.
- **Output size.** Output over 24,000 characters is cut, with a note to narrow the request.
- **Scope.** Orchard refuses operations that need a higher scope than the connection has. The error names the required scope.

Results from operations flagged `x-orchard-sensitive` carry `_meta: { "orchard/sensitive": true }`.

Each call is one turn for the model. Scripts in a shell need fewer turns for work that chains several calls.

## Related resources

- [Connect an MCP client](/mcp/)
- [CLI](/cli/)
- [Docs for agents](/for-agents/)
