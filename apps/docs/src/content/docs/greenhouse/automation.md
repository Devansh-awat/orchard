---
title: Automating Greenhouse
description: Drive machines and sessions from MCP agents, the CLI and the API.
sidebar:
  order: 12
---

Everything in the workspace has an API underneath, and the parts worth scripting
are exposed through the [MCP server](/mcp/) and the [CLI](/cli/). Both act as you,
with the same roles and permissions as the browser: a guest can prompt over MCP,
a read-only guest cannot.

## MCP tools

An agent connected to Orchard's MCP server can work with Greenhouse through these
tools. They are not in the default toolsets: connect with `?toolsets=default,greenhouse`
(or `?toolsets=all`) to see them. The agent inside a machine is connected with
`?toolsets=default,databases,greenhouse` already. Full parameter lists are in the generated
[MCP tools reference](/reference/mcp-tools/#sandboxes).

| Tool                             | Does                                                                                                              | Needs             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------- |
| `list_sandboxes`                 | Machines you host or were invited to, with status, runner and your role. Also your machine limit and the runners. | any role          |
| `get_sandbox`                    | One machine: status, desired state, whether a change is still applying, runner, image, owner, your role.          | any role          |
| `start_sandbox`                  | Start a stopped machine. Returns at once with `starting`; poll `get_sandbox`.                                     | guest or host     |
| `stop_sandbox`                   | Stop a machine. Its disk is kept.                                                                                 | host or org admin |
| `list_sandbox_sessions`          | Sessions with branch, diffstat, ahead and behind, activity and pull request.                                      | any role          |
| `create_sandbox_session`         | New session on a running machine for a repository, optionally with a first prompt.                                | guest or host     |
| `prompt_sandbox_session`         | Send a prompt to a session's agent, attributed to you.                                                            | guest or host     |
| `get_sandbox_session_diff`       | Changed files with line counts and the unified diff (up to 200 KB), or one file's diff.                           | any role          |
| `get_sandbox_session_transcript` | The latest messages of the session's chat as text, with who sent each prompt.                                     | any role          |
| `create_sandbox_session_pr`      | Open a GitHub pull request (optionally a draft) for the session's branch, pushing it first when needed.           | see below         |

Pull requests opened over MCP follow the same rule as in the browser: they use
the GitHub account of the person the MCP connection belongs to. Push the branch
first, or ask the agent to.

A typical loop for an orchestrating agent: `list_sandboxes`, `start_sandbox` if
needed, `create_sandbox_session` with a prompt, then poll
`list_sandbox_sessions` until the session's activity is back to `idle`, read
`get_sandbox_session_transcript` and `get_sandbox_session_diff`, and either
prompt again or open a pull request.

### The agent inside a machine

When the instance publishes its MCP server over HTTPS, each machine's opencode
agent is configured with an `orchard` MCP server too, authenticated as the host.
The agent in a machine can therefore look up the host's deployments, logs and
databases while it works. Its access is exactly the host's; a guest prompting the
agent reaches Orchard as the host through it, which is part of what
[sharing a machine](/greenhouse/sharing/#what-sharing-gives-your-guests) means.

## CLI

The CLI covers machines, sessions, sharing and SSH. Every command is listed with
its flags in the generated [CLI reference](/reference/cli/#sandbox). Machines can
be named by name, id or a unique id prefix; sessions by id or slug.

| Command                                                                           | Does                                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `orchard sandbox create [name] --repo <url> --runner <kubernetes\|vercel>`        | Create a machine. `--setup file.sh` sets the machine setup script.          |
| `orchard sandbox list`, `get <name>`                                              | List machines, or show one.                                                 |
| `orchard sandbox start <name>`, `stop <name>`, `delete <name>`                    | Lifecycle.                                                                  |
| `orchard sandbox retry <name>`                                                    | Queue the machine's failed changes again (host or org admin).               |
| `orchard sandbox update <name> --name ... --identity ...`                         | Rename, switch SSH identity, change the setup script.                       |
| `orchard sandbox ssh <name> [-- ssh-args]`                                        | Open a shell over the tunnel. `--start` starts it first.                    |
| `orchard sandbox ssh-config --install`                                            | One-time setup for `ssh orchard-<name>` and editor links.                   |
| `orchard sandbox repo list <name>`, `repo add <name> <url>`                       | Repositories on a machine.                                                  |
| `orchard sandbox session list <name>`                                             | Sessions with branch, diffstat and pull request. `--all` includes archived. |
| `orchard sandbox session create <name> <repo> --prompt "..."`                     | New worktree session. `--base` and `--title` are optional.                  |
| `orchard sandbox session prompt <name> <session> [text\|-]`                       | Prompt a session's agent as yourself; `-` or no text reads stdin.           |
| `orchard sandbox session transcript <name> <session>`                             | Print the latest messages. `--limit` up to 200.                             |
| `orchard sandbox session archive <name> <session>`                                | Archive a session; `--restore` brings it back.                              |
| `orchard sandbox session preview <name> <session> --project <p>`                  | Deploy the session as a preview environment; `--remove` tears it down.      |
| `orchard sandbox fork <name> [--name new]`                                        | Fork a machine you host.                                                    |
| `orchard sandbox share create <name> [--session s] [--expires-in hours]`          | Create a read-only share link. The token is printed once.                   |
| `orchard sandbox share list <name>`, `share revoke <name> <link-id>`              | Manage share links.                                                         |
| `orchard sandbox link add <name> <project> [--env e]`, `link list`, `link remove` | Attach or detach an Orchard project's environment.                          |
| `orchard sandbox credentials set --claude - \| --openai -`, `status`, `clear`     | Agent tokens for the machines you host.                                     |
| `orchard sandbox diff <name>`                                                     | The git diff inside a machine. `--stat` for a file list.                    |

`sb` is a short alias for `sandbox`, and `sessions` for `session`. Add `-o json`
to any command for machine-readable output.

Commands that open a connection into a machine (sessions, prompts, SSH, files)
need the `exec` scope when the CLI uses an API token.

## API

The REST API is under `/apiv1/sandboxes` and documented in the
[API reference](/api/). Live features use three WebSocket endpoints on the same
host, all authenticated with your session cookie or a bearer token with the
`exec` scope:

| Endpoint                        | What it carries                                              |
| ------------------------------- | ------------------------------------------------------------ |
| `/apiv1/sandboxes/:id/terminal` | Terminals, with resume after a dropped connection            |
| `/apiv1/sandboxes/:id/live`     | Presence, typing, comments, follow and collaborative editing |
| `/apiv1/sandboxes/:id/ssh`      | Raw SSH bytes, used by `orchard sandbox proxy`; host only    |
