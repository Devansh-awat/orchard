---
title: Greenhouse
description: An AI development environment built into Orchard, with parallel agent sessions on their own git worktrees.
sidebar:
  order: 1
  label: Overview
---

Greenhouse is Orchard's AI development environment. You get a cloud machine with
your repositories on it, and you run coding agents against those repositories in
parallel: each agent works on its own branch in its own git worktree, so they
never step on each other. You review what they did in a full IDE in the browser,
or open the same machine in VS Code, Cursor or Zed.

It is for writing code, not for serving traffic. When something is ready, push it,
open a pull request, or [deploy the session as a preview
environment](/greenhouse/previews/#deploy-a-session-as-a-preview-environment).

The product is called Greenhouse in the dashboard. The API, the CLI and the MCP
tools call a machine a **sandbox** (`/sandboxes`, `orchard sandbox`,
`list_sandboxes`), so both words refer to the same thing.

## Machines, sessions and chats

Three nested things, and it helps to keep them apart.

| Thing       | What it is                                                                                                                                         | Lives                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Machine** | An isolated Linux box with a persistent home directory, its own repositories and its own agent server. Start it, stop it, share it, fork it.       | One per sandbox, on a [runner](#runners)    |
| **Session** | One piece of work: a git worktree on a fresh branch `orchard/<slug>`, an agent working in it, its diff, its pull request and its preview.          | `~/.worktrees/<repo>/<slug>` on the machine |
| **Chat**    | One conversation with the agent inside a session. A session starts with one chat and can have more as tabs; they all share the session's worktree. | The agent server on the machine             |

A machine is a computer, not a checkout. Clone as many repositories into it as
you like; each lands in `~/<repo>` (the home directory is `/persist/home`). A
session always belongs to one repository and branches off it.

### One worktree per session

Creating a session runs `git worktree add` against the repository's default
branch (or a base branch you pick), on a branch named `orchard/<slug>`. Three
sessions on the same repository are three directories and three branches, so
three agents can run side by side, each with its own diff, its own terminals and
its own dev server.

Archiving a session removes the worktree and keeps the branch. Restoring it puts
the worktree back. Deleting a session removes the worktree and, if you ask, the
branch too.

## The agent

Every machine runs an [opencode](https://opencode.ai) server, and that is the
agent the chat talks to. It uses the Claude Code token you store under
**User settings → Sandbox**, so the agent runs on your Claude subscription.
Claude Code and Codex are installed as command-line tools as well, for when you
would rather drive them from a terminal.

The agent works on real files with real git. Its edits show up in the session's
diff as it goes, and anything you or a teammate change in the editor is on the
same disk.

## Runners

Where a machine runs is decided when it is created, by its **runner**. An instance
offers one or both:

| Runner         | What a machine is                                                                                   | Stop keeps                | Previews                         |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| **Kubernetes** | A pod on the instance's own cluster, a Kata VM when the operator has Kata, with a persistent volume | The home volume           | Private, through Orchard's proxy |
| **Vercel**     | A Vercel Sandbox microVM on the operator's Vercel account                                           | A snapshot of the machine | Public URLs on Vercel's domain   |

The new machine sheet shows only the runners that are available, with the
instance default selected. [Machines](/greenhouse/machines/) covers the
differences in detail.

## Isolation

A machine cannot reach your cluster. On Kubernetes it gets internet egress only:
no other workloads, no cluster services, no cloud metadata, no other machines.
There is no ingress at all; SSH, terminals and previews are tunnelled through the
Orchard server, which checks who you are on every connection.

What a machine **does** hold is the credentials of the person who owns it: their
Claude token, their GitHub access for the agent, and anything they put in it.
Treat a machine you share accordingly. [Sharing](/greenhouse/sharing/) spells
out exactly what a guest gets.

## Where to go next

- [Get started](/greenhouse/getting-started/): a machine and a first session in a few minutes.
- [The workspace](/greenhouse/workspace/): the IDE, the chat thread and the keyboard shortcuts.
- [Open in your editor](/greenhouse/editors/): VS Code, Cursor and Zed over SSH.
- [Sharing and multiplayer](/greenhouse/sharing/): hosts, guests and what each can do.
