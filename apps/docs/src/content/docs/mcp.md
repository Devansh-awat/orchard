---
title: MCP for agents
description: Connect Claude or any MCP client and let it deploy, provision and debug.
---

Orchard ships a Model Context Protocol server, so an agent can operate the
platform through the same API the dashboard uses.

Every tool is listed in the **[MCP tools reference](/reference/mcp-tools/)**,
generated from the server's own tool registry.

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

Scopes nest, so `exec` covers `deploy` and `deploy` covers `read`. A tool that
needs more than the token has fails with `Token lacks required scope: …`.

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
- Create and manage databases, take and restore backups
- Read pod logs, build logs, and the logs of containers that already died
- Inspect metrics and triage a failing deployment
- Manage environment variables, domains, jobs and notification channels

Tools carry hints about their behaviour, `readOnlyHint`, `destructiveHint`,
`idempotentHint`, so a well-behaved client can be cautious about the destructive
ones without you configuring anything.

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
which is where an agent is most useful and least dangerous.
