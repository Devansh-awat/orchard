---
title: Automate Greenhouse
description: Control Greenhouse machines and sessions with Orchard's MCP tools, the Orchard CLI, and the REST API. Every interface acts as you, with the same roles as the dashboard.
sidebar:
  order: 12
---

To control machines and sessions from an agent or a script, use the [MCP server](/mcp/), the [CLI](/cli/), or the [API](/api/). Each one acts as you, with the same roles as the dashboard. For example, a guest can prompt an agent over MCP, and a read-only guest cannot.

## Use MCP tools

An agent connected to Orchard's Model Context Protocol (MCP) server can use these tools. For parameters, refer to the [MCP tools reference](/reference/mcp-tools/#greenhouse-graft).

| Tool                             | Action                                                                                                | Required role     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `list_sandboxes`                 | Lists machines you host or were invited to, your machine limit, and the runners.                      | Any               |
| `get_sandbox`                    | Returns one machine's status, desired state, runner, image, owner, and your role.                     | Any               |
| `start_sandbox`                  | Starts a stopped machine. Returns `starting` immediately. Poll `get_sandbox` until it is running.      | Guest, host, or organization admin |
| `stop_sandbox`                   | Stops a machine. Its disk is kept.                                                                    | Host or organization admin |
| `list_sandbox_sessions`          | Lists sessions with branch, diffstat, activity, and pull request.                                     | Read-only guest or higher |
| `create_sandbox_session`         | Creates a session on a running machine, optionally with a first prompt.                               | Guest or host     |
| `prompt_sandbox_session`         | Sends a prompt to a session's agent, attributed to you.                                               | Guest or host     |
| `get_sandbox_session_diff`       | Returns changed files and the unified diff of uncommitted work, up to 200 KB.                         | Read-only guest or higher |
| `get_sandbox_session_transcript` | Returns the latest messages of the session's chat as text.                                            | Read-only guest or higher |
| `create_sandbox_session_pr`      | Opens a pull request with your linked GitHub account, and pushes the branch first if needed.          | Guest or host     |

These tools are on by default. If you set `toolsets` on the server URL, add `greenhouse` to keep them:

```text
https://mcp.your-orchard-domain/?toolsets=deployments,logs,greenhouse
```

If the instance has PostHog configured, accounts without the `greenhouse` feature flag do not see these tools.

To orchestrate a session, follow this sequence:

1. Call `list_sandboxes`, and `start_sandbox` if needed.
2. Call `create_sandbox_session` with a prompt.
3. Poll `list_sandbox_sessions` until the session's activity is `idle`.
4. Call `get_sandbox_session_transcript` and `get_sandbox_session_diff`.
5. Prompt again, or call `create_sandbox_session_pr`.

### The agent on a machine

If the instance publishes its MCP server over HTTPS, the opencode agent on each machine connects to it as the host. The agent can look up the host's deployments, logs, and databases. A guest who prompts the agent reaches Orchard as the host. Refer to [What sharing gives your guests](/greenhouse/sharing/#what-sharing-gives-your-guests).

## Use the CLI

`sb` is an alias for `sandbox`, and `sessions` is an alias for `session`. You can refer to a machine by name, ID, or a unique ID prefix, and to a session by ID or slug. For all commands and flags, refer to the [CLI reference](/reference/cli/#sandbox).

| Command                                                                     | Action                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `orchard sandbox create [name] --repo <url> --runner <kubernetes\|vercel>`  | Creates a machine.                                   |
| `orchard sandbox list`, `get <name>`, `usage <name>`                        | Lists machines, or shows one machine or its usage.   |
| `orchard sandbox start <name>`, `stop <name>`, `delete <name>`              | Starts, stops, or deletes a machine.                 |
| `orchard sandbox retry <name>`                                              | Queues the machine's failed changes again.           |
| `orchard sandbox update <name> --name ... --identity ...`                   | Renames a machine, or changes its SSH identity or setup script. |
| `orchard sandbox fork <name> [--name new]`                                  | Forks a machine you host.                            |
| `orchard sandbox ssh <name> [-- ssh-args]`                                  | Opens a shell over the tunnel.                       |
| `orchard sandbox ssh-config --install`                                      | Configures `ssh orchard-<name>` and editor links.    |
| `orchard sandbox repo list <name>`, `repo add <name> <url>`                 | Lists or clones repositories.                        |
| `orchard sandbox session list <name>`                                       | Lists sessions. `--all` includes archived sessions.  |
| `orchard sandbox session create <name> <repo> --prompt "..."`               | Creates a session. `--agent`, `--base`, and `--title` are optional. |
| `orchard sandbox session prompt <name> <session> [text\|-]`                 | Sends a prompt as you. `-` or no text reads stdin.   |
| `orchard sandbox session transcript <name> <session>`                       | Prints the latest messages. `--limit` goes up to 200. |
| `orchard sandbox session archive <name> <session>`                          | Archives a session. `--restore` restores it.         |
| `orchard sandbox session preview <name> <session> --project <p>`            | Deploys a preview environment. `--remove` removes it. |
| `orchard sandbox share create <name>`, `share list`, `share revoke`         | Manages read-only links.                             |
| `orchard sandbox link add <name> <project> [--env e]`, `link list`, `link remove` | Attaches or detaches a project environment.    |
| `orchard sandbox credentials set`, `status`, `clear`                        | Manages your agent tokens.                           |
| `orchard sandbox diff <name>`                                               | Prints the git diff on a machine. `--stat` prints a file list. |

Add `-o json` for machine-readable output.

If the CLI uses an API token, commands that connect into a machine require the `exec` scope. These include sessions, prompts, SSH, and file operations.

## Use the API

The REST API is under `/apiv1/sandboxes`. For its operations, refer to the [API reference](/api/).

Live features use three WebSocket endpoints on the same host. They authenticate with your session cookie or a bearer token with the `exec` scope.

| Endpoint                        | Carries                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `/apiv1/sandboxes/:id/terminal` | Terminals, with resume after a dropped connection             |
| `/apiv1/sandboxes/:id/live`     | Presence, typing, comments, follow, and collaborative editing |
| `/apiv1/sandboxes/:id/ssh`      | SSH bytes, used by `orchard sandbox proxy`. Host only.        |

## Related resources

- [Connect an MCP client](/mcp/)
- [Manage API tokens](/account/tokens/)
