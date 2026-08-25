---
title: Sandboxes
description: Isolated cloud dev environments with a workspace, git, and an agent inside.
sidebar:
  order: 9
---

A sandbox is an isolated cloud development environment: a persistent workspace
you can open in the browser, with an editor, a terminal, git, and an agent that
can work in it.

They are for development, not for serving traffic. Deploy an [app](/deploy/github/)
when you want something running for users.

## Isolation

Sandboxes run as **Kata VMs** rather than ordinary containers, so the boundary is
a virtual machine rather than a shared kernel. They get **internet egress only**:
a sandbox can reach out, but cannot reach other workloads in your cluster.

That is deliberate. A sandbox is where you run code you are still writing, and
occasionally code you do not fully trust.

## Creating one

Sandboxes are scoped to an organization. Owners and admins can see every sandbox
in theirs; everyone else sees their own.

Starting one reports **boot progress**, so a sandbox that is still setting up
says so instead of showing an empty terminal.

## The workspace

The workspace persists across restarts. Deleting the sandbox deletes it.

Inside the browser you get:

- a **file explorer** and **code editor**, reading and writing files in the workspace
- a **terminal** attached to the running sandbox
- a **git panel**

## Git

Full git operations, without dropping to the terminal unless you want to:

|                  |                                                    |
| ---------------- | -------------------------------------------------- |
| Branches         | List local and remote, with tracking info          |
| Checkout         | Switch, or create from a base ref                  |
| Changes and diff | Working-tree changes, whole tree or a single file  |
| Commit           | Stage and commit everything, or named files        |
| Uncommit         | Soft reset the last commit, keeping changes staged |
| Fetch            | All remotes, pruning deleted branches              |
| Pull             | Current branch, optionally rebasing                |
| Push             | Current branch; force uses `--force-with-lease`    |
| Pull request     | Open a GitHub PR from the current branch           |

Force-push uses `--force-with-lease`, so it refuses when the remote moved under
you rather than overwriting someone else's work.

## The agent

A sandbox can run Claude against its workspace. Messages stream back as they are
produced, and work happens in the sandbox, on real files, with real git.

Conversations are kept as a list you can rename and delete. Transcripts live on
the sandbox's own disk, so deleting a conversation record does not scrub the
session file from the machine.

A conversation can be pointed at a repository as its working directory, fixed
before the first message.

## SSH access

Attach an [SSH identity](/account/ssh-identities/) to connect from your own
terminal or point a local editor at the sandbox.

## Deleting

Deleting a sandbox deletes its persistent workspace. Anything not committed and
pushed is gone. Push your branch before you delete.
