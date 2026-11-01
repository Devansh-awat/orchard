---
title: MCP for agents
description: Connect Claude or any MCP client and let it deploy, provision and debug.
---

Orchard ships a Model Context Protocol server, so an agent can operate the
platform through the same API the dashboard uses.

There are two endpoints on the same server:

| URL        | What it is                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `/`        | The normal MCP: about 160 purpose-built tools, grouped into toolsets                             |
| `/compact` | The compact MCP: three tools (`search_api`, `describe_operation`, `call_api`) over the whole API |

Every normal tool is listed in the **[MCP tools reference](/reference/mcp-tools/)**,
generated from the server's own tool registry. The compact MCP and the CLI
scripting flow are covered in [Code mode for agents](/agents-code-mode/).

## Connecting

The MCP server answers on its own hostname, a sibling of the dashboard's:

```
https://mcp.your-orchard-domain
```

**Settings → MCP** shows the exact URL for the instance you are signed in to,
along with ready-made configuration for Claude.ai, Claude Code, VS Code and
Cursor. Copy it from there rather than guessing.

Whichever way it authenticates, the agent acts **as you**: it sees what you can
see and can change what you can change. It does not get a privileged service
account, and it cannot reach another organization's resources because you
connected an agent.

If that page says the instance has not published an MCP endpoint, it has not been
turned on. See
[Turn the MCP endpoint on or off](/operate/finishing-setup/#turn-the-mcp-endpoint-on-or-off).

## Authenticating

There are two ways in. Use OAuth when a person is at the keyboard, and an API
token when nobody is.

### OAuth (interactive)

Add the URL with no credentials. On first use the client opens a browser, you
sign in to Orchard and approve the connection, and the client stores and
refreshes the token itself. Access tokens last a day and refresh without asking;
a connection left unused for 30 days has to sign in again.

An OAuth connection carries one of three scopes, the same ladder API tokens use:

| Scope        | Lets the agent                                            |
| ------------ | --------------------------------------------------------- |
| `mcp:read`   | Read-only tools: list, get, logs, metrics, rollout status |
| `mcp:deploy` | Everything `mcp:read` can, plus every change              |
| `mcp:exec`   | Everything `mcp:deploy` can, plus `exec_in_pod`           |

A client that asks for no scope, or for the older `mcp:access`, gets
`mcp:exec`, and connections made before scopes existed keep everything they
had. The consent screen shows "Also allow running commands inside containers"
ticked; untick it to keep a connection to reading and deploying. The scope is
enforced by the API itself, not just by which tools are listed.

To hand out a narrower connection without relying on the client, add `scope`
to the server URL. It only ever lowers what the connection gets:

```
https://mcp.your-orchard-domain/?scope=read
https://mcp.your-orchard-domain/?scope=deploy
```

**Settings → MCP** builds this URL for you: pick toolsets and access, then copy
the URL or a ready-made config for Claude Code, VS Code or Cursor.

Clients that registered with `client_secret_post` must send their secret on
every token request, including refreshes.

### API token (non-interactive)

For CI, headless agents, or a client without OAuth support, send a personal API
token (`orch_…`) as a bearer token:

```json
{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "https://mcp.your-orchard-domain/",
      "headers": {
        "Authorization": "Bearer orch_your_token_here"
      }
    }
  }
}
```

With Claude Code:

```sh
claude mcp add --transport http orchard https://mcp.your-orchard-domain/ \
  --header "Authorization: Bearer orch_your_token_here"
```

When an `Authorization` header is set, Claude Code does not fall back to OAuth.
A rejected token is a hard `401`, not a sign-in prompt.

The MCP server calls the Orchard API with your token, so the token's own limits
apply to every tool call:

| Scope    | Lets the agent                                                                 |
| -------- | ------------------------------------------------------------------------------ |
| `read`   | Run the read-only tools: list, get, logs, metrics                              |
| `deploy` | Everything `read` can, plus anything that changes state: deploy, scale, delete |
| `exec`   | Everything `deploy` can, plus `exec_in_pod`                                    |

Scopes nest, so `exec` covers `deploy` and `deploy` covers `read`. Tools the
token cannot run are left out of the tool list, and anything that still needs
more than the token has fails with `Token lacks required scope: …`.

Tokens created in **Settings → API Tokens** get the `read` scope only. That is
enough for diagnosis. For an agent that acts, create the token with the CLI:

```sh
orchard auth token create --name "ci-agent" --scope deploy
orchard auth token create --name "ops-agent" --scope exec --project my-app
```

`--project` (repeatable) restricts the token to those projects; leave it out
and the token reaches everything you can. Tokens live at most 90 days
(`--expires-in` sets a shorter lifetime), so plan to rotate them. Whatever its
scope, a token can never register a passkey, set a password, or reach the
instance setup and admin routes.

### When it fails

| Response                     | Meaning                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `401` on connect             | The token is unknown, expired or revoked, or the header is not `Bearer orch_…`              |
| `Token lacks required scope` | The token is valid but its scope is too narrow for that tool; create one with a wider scope |
| `503 MCP is disabled`        | An operator has switched MCP off for the instance; see [Turning it off](#turning-it-off)    |

## What it can do

The tools cover the same ground as the dashboard:

- Deploy from GitHub or an image, scale, restart, roll back
- Ask whether a deploy is live and, if not, why (`get_deployment_rollout`)
- Create and manage databases, take and restore backups
- Read pod logs, build logs, and the logs of containers that already died
- Inspect metrics and triage a failing deployment
- Manage environment variables, domains, jobs and notification channels

### Toolsets

The tools are grouped into toolsets. A connection sees all of them unless its
URL picks some, which is worth doing for an agent that only needs a few, since
every listed tool costs context before it has done anything:

| Toolset         | Covers                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| `core`          | Who am I, organizations, projects, `find`, deployments at a glance       |
| `deployments`   | Create, build, scale, restart, roll back, rollout status, compose stacks |
| `logs`          | Runtime and build logs, pods, killed containers, errors, metrics, exec   |
| `env`           | Environment variables and environments                                   |
| `databases`     | Databases, credentials, backups, extensions, settings                    |
| `domains`       | Domains, services, DNS checks, domain protection                         |
| `jobs`          | Scheduled and on-demand jobs and their runs                              |
| `notifications` | Notification channels, rules and deliveries                              |
| `templates`     | Templates and template instances                                         |
| `dangerous`     | Every delete, plus restoring a database backup                           |

Every toolset, graft tools included, is on by default. To keep an agent's
context small, list only the toolsets it needs; `core` is always included:

```
https://mcp.your-orchard-domain/?toolsets=databases,domains
https://mcp.your-orchard-domain/?toolsets=deployments,logs,greenhouse
```

A graft's tools appear when its id is listed (`greenhouse` above), and with no
`toolsets` at all. The local stdio server reads the same list from
`ORCHARD_MCP_TOOLSETS`.

### Behaviour hints

Every tool has a title and the full set of hints: `readOnlyHint`,
`destructiveHint`, `idempotentHint` and `openWorldHint`. Tools that replace a
whole list (`set_env_vars`, `update_deployment_volumes`, `update_service`,
`update_database_settings`) are marked destructive, so a careful client asks
before running them.

The core read tools (`find`, `list_projects`, `list_deployments`,
`get_deployment`, `get_deployment_rollout`) also return `structuredContent`
with a declared `outputSchema`. The JSON text block is still there for clients
that ignore structured output. List tools take `limit` and `cursor` and return
`{ items, total, nextCursor }`.

### Secrets

Reads never return secret material. Database passwords, secret environment
variables and job secrets come back masked. The handful of tools whose whole
point is a secret say so: `get_database_connection`,
`create_deploy_webhook_token`, `create_notification_channel`,
`get_ingress_protection` and `exec_in_pod` end their description with
`[sensitive]` and carry `_meta: { "orchard/sensitive": true }` on the tool and
on every result, so a client can keep that output out of logs and transcripts.
Revealing database credentials is recorded in the audit log.

### Resources

The server also publishes two read-only resources:

| URI                                  | Contents                                       |
| ------------------------------------ | ---------------------------------------------- |
| `orchard://docs/template-yaml-guide` | The `leaf/v1` template format, with an example |
| `orchard://docs/llms.txt`            | The index of these docs, fetched from the site |

## Revoking access

An OAuth connection is backed by an auth session, so revoking it is the same as
revoking any other session for your account. There is no separate list of agent
grants to forget about.

A token-authenticated agent loses access as soon as you revoke the token, in
**Settings → API Tokens** or with `orchard auth token revoke <id>`. Signing out
everywhere revokes your sessions and all of your API tokens.

MCP grants hold their own session, so an ordinary role change does not silently
kill a working agent connection mid-task.

## Turning it off

An instance operator can switch MCP off entirely, at
**Instance admin → Configuration**. Every MCP request is then refused and the
setup instructions disappear from user settings. It is on by default.

## A reasonable workflow

Give the agent a job, not the keys to everything:

> "The `api` app is crash-looping. Read its logs, work out why, and tell me. Do
> not change anything."

Then decide whether to let it act. The read-only tools are enough for diagnosis,
which is where an agent is most useful and least dangerous. Connecting it with
`mcp:read` makes that a guarantee rather than a request.
