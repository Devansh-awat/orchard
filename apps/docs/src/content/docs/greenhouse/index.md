---
title: Greenhouse
description: Greenhouse is an Orchard graft that runs coding agents on cloud machines, with each session on its own git worktree. It is available on instances where an operator has installed the greenhouse graft.
sidebar:
  order: 1
  label: Overview
---

Run coding agents on cloud machines that your Orchard instance manages.

Greenhouse is a first-party [graft](/grafts/overview/) for Orchard. It gives you an isolated Linux machine with your repositories on it. Each agent session works on its own branch in its own git worktree, so several sessions can run on one machine at the same time. You review the changes in a browser workspace, or in a desktop editor over SSH.

Greenhouse is for writing code. To serve traffic, deploy the code to Orchard as an app.

Greenhouse is available when an operator installs the `greenhouse` graft on your instance. If the instance has PostHog configured, your account also needs the `greenhouse` feature flag. For more information, refer to [Run Greenhouse](/operate/greenhouse/).

## Get started

- [Get started](/greenhouse/getting-started/): Create a machine and start your first session.

## Terms

| Term    | Definition                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine | An isolated Linux environment with a persistent home directory. It holds your repositories and sessions. The person who creates it is its **host**. |
| Session | One piece of work: a git worktree on a new branch, an agent working in it, and its diff, pull request, and preview.                             |
| Chat    | One conversation with the agent in a session. A session can have several chats. All of them share the session's worktree.                       |
| Runner  | The system a machine runs on: Kubernetes or Vercel. You choose the runner when you create the machine.                                          |

The API, the CLI, and the Model Context Protocol (MCP) tools call a machine a **sandbox**. For example, `orchard sandbox list` lists your machines.

## Coding agents

A session runs one of these agents. You pick the agent in the model menu of the chat.

| Agent       | CLI value                | Credentials                                                       |
| ----------- | ------------------------ | ----------------------------------------------------------------- |
| opencode    | `opencode`, `acp:opencode` | Your Claude token and OpenAI key, if set, and opencode's free models |
| Claude Code | `acp:claude`             | Your Claude token                                                 |
| Codex       | `acp:codex`              | A ChatGPT sign-in or an OpenAI key                                |
| fx          | `acp:fx`                 | A Vercel AI Gateway, ChatGPT, or Grok sign-in, or an AI Gateway key |

The default agent is `opencode`. An operator can change the default with `SANDBOX_DEFAULT_AGENT`.

## Runners

An instance offers one or both runners.

| Runner     | A machine is                                                   | A stopped machine keeps             | Previews                                     |
| ---------- | -------------------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| Kubernetes | A pod on the cluster, in a Kata VM if the operator configured Kata | Its home volume                     | Private, through the Orchard server          |
| Vercel     | A Vercel Sandbox on the operator's Vercel account              | Its drive and a filesystem snapshot | Public URLs that anyone with the link can open |

For more information, refer to [Machines](/greenhouse/machines/).

## Security

A machine holds the credentials of its host, including agent tokens and GitHub access. Share a machine only with people you trust with those credentials. For more information, refer to [Share a machine](/greenhouse/sharing/).

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
