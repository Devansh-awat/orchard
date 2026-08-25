---
title: MCP for agents
description: Connect Claude or any MCP client and let it deploy, provision and debug.
---

Orchard ships a Model Context Protocol server, so an agent can operate the
platform through the same API the dashboard uses.

Every tool is listed in the **[MCP tools reference](/reference/mcp-tools/)**,
generated from the server's own tool registry.

## Connecting

Point your MCP client at your instance:

```
https://your-orchard/mcp
```

Authorisation goes through OAuth against your Orchard instance. The agent acts
**as you**: it sees what you can see and can change what you can change. It does
not get a privileged service account, and it cannot reach another organization's
resources because you connected an agent.

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

An MCP connection is backed by an auth session, so revoking it is the same as
revoking any other session for your account. There is no separate list of agent
grants to forget about.

MCP grants hold their own session, so an ordinary role change does not silently
kill a working agent connection mid-task.

## A reasonable workflow

Give the agent a job, not the keys to everything:

> "The `api` app is crash-looping. Read its logs, work out why, and tell me. Do
> not change anything."

Then decide whether to let it act. The read-only tools are enough for diagnosis,
which is where an agent is most useful and least dangerous.
