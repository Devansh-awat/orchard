---
title: Greenhouse
description: Greenhouse is an Orchard graft that runs coding agents on cloud machines, with each session on its own git worktree. It is available on instances where an operator has installed the greenhouse graft.
sidebar:
  order: 1
  label: Overview
---

Greenhouse runs coding agents on cloud machines that your Orchard instance manages, so agents work away from your laptop and keep working after you close it. It is a first-party [graft](/grafts/overview/), an extension that an operator installs on the instance. Greenhouse gives you an isolated Linux machine with your repositories on it. Each agent session works on its own branch in its own git worktree, which means several sessions can run on one machine at the same time without touching each other's files. You review the changes in a browser workspace, or in a desktop editor over SSH.

Greenhouse is for writing code. To serve traffic, [deploy the code to Orchard as an app](/start/first-deploy/).

Greenhouse is available when an operator [installs the `greenhouse` graft](/operate/greenhouse/) on your instance. If the instance has PostHog configured, your account also needs the `greenhouse` feature flag.

## Get started

- [Get started](/greenhouse/getting-started/): Create a machine and start your first session.

## Terms

| Term    | Definition                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine | An isolated Linux environment with a persistent home directory. It holds your repositories and sessions. The person who creates it is its **host**. |
| Session | One piece of work: a git worktree on a new branch, an agent working in it, and its diff, pull request, and preview.                                 |
| Chat    | One conversation with the agent in a session. A session can have several chats. All of them share the session's worktree.                           |
| Runner  | The system a machine runs on: Kubernetes or Vercel. You choose the runner when you create the machine.                                              |

The API, the [CLI](/reference/cli/#sandbox), and the [Model Context Protocol (MCP) tools](/reference/mcp-tools/#greenhouse-graft) call a machine a **sandbox**. For example, `orchard sandbox list` lists your machines.

## Coding agents

A session runs one of these agents. You select the agent in the model menu of the chat.

| Agent       | CLI value                  | Credentials                                                          |
| ----------- | -------------------------- | -------------------------------------------------------------------- |
| opencode    | `opencode`, `acp:opencode` | Your Claude token and OpenAI key, if set, and opencode's free models |
| Claude Code | `acp:claude`               | Your Claude token                                                    |
| Codex       | `acp:codex`                | A ChatGPT sign-in or an OpenAI key                                   |
| fx          | `acp:fx`                   | A Vercel AI Gateway, ChatGPT, or Grok sign-in, or an AI Gateway key  |

The default agent is `opencode`. An operator can change the default with `SANDBOX_DEFAULT_AGENT`.

## Runners

An instance offers one or both runners.

| Runner     | A machine is                                                       | A stopped machine keeps             | Previews                                       |
| ---------- | ------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------- |
| Kubernetes | A pod on the cluster, in a Kata VM if the operator configured Kata | Its home volume                     | Private, through the Orchard server            |
| Vercel     | A Vercel Sandbox on the operator's Vercel account                  | Its drive and a filesystem snapshot | Public URLs that anyone with the link can open |

[Machines](/greenhouse/machines/) describes what each runner keeps and which limits apply.

## Security

A machine holds the credentials of its host, including agent tokens and GitHub access. [Share a machine](/greenhouse/sharing/) only with people you trust with those credentials.

On the Kubernetes runner, a machine has internet egress only. It cannot reach cluster services, other machines, or cloud metadata. Nothing outside the cluster can connect to it directly. SSH, terminals, and previews go through the Orchard server.

## Guides

- [Workspace](/greenhouse/workspace/): The browser workspace, slash commands, and keyboard shortcuts.
- [Connect an editor over SSH](/greenhouse/editors/): Open a session in VS Code, Cursor, or Zed.
- [Configure setup and run scripts](/greenhouse/scripts/): Prepare each new worktree and start your app.
- [Preview a session](/greenhouse/previews/): Open a running dev server, or deploy a session as a preview environment.
- [Commit, push, and merge](/greenhouse/pull-requests/): Open a pull request and follow its checks.
- [Attach an Orchard project](/greenhouse/projects/): Load a project's variables into a machine.
- [Share a machine](/greenhouse/sharing/): Invite people and create read-only links.
- [Start sessions from GitHub, Linear, and Slack](/greenhouse/integrations/): Start a session from an issue or a message.
- [Automate Greenhouse](/greenhouse/automation/): Use MCP tools, the CLI, and the API.
- [Troubleshooting Greenhouse](/greenhouse/troubleshooting/): Fix common failures by symptom.

## Related resources

- [Manage SSH identities](/account/ssh-identities/) - Add the SSH keys that editors and `ssh` use to connect to a machine.
- [Connect an MCP client](/mcp/) - Connect an agent to Orchard's MCP server to drive Greenhouse from outside the workspace.
