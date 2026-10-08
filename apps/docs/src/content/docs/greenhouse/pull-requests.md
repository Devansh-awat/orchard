---
title: Pull requests and checks
description: Commit, push, open a pull request, follow CI and merge, all from the session.
sidebar:
  order: 8
---

Each session is a branch, so the path from "the agent finished" to "it is merged"
is short: commit, push, open a pull request, watch the checks, merge.

Pushes, pull requests and merges all use **your own** linked GitHub account,
whoever you are on the machine. Link it under **User settings → GitHub and
Tailscale**. Until you do, the pull request button reads **Link GitHub to push**;
you can still commit locally.

## Commit

The **Changes** tab lists what changed in the session's worktree. Write a message
in the commit box and press **Commit** (**⌘Enter**) to commit everything that
changed. The commit menu has **Amend last commit**. Through the API you
can also commit only tracked files or a list of files, add a sign-off line, or
undo the last commit while keeping its changes staged.

Commits made here carry your name and email: those of your GitHub account, using
its `noreply` address, or your Orchard name and email when GitHub is not linked.
When other people prompted the agent in this session, a `Co-authored-by` trailer
is added for each of them.

The agent commits too, when you ask it to. Its commits are the host's, because
the agent runs as the host, with trailers for the people who prompted it.

## Push and open a pull request

The pull request button at the top right of the workspace changes as the work
moves along:

| State               | Button          | Menu                                                                      |
| ------------------- | --------------- | ------------------------------------------------------------------------- |
| No pull request yet | **Create PR**   | Create pull request, Create draft pull request, Push only, Deploy preview |
| Pull request open   | **View PR #12** | Push only, Squash and merge, Deploy preview                               |
| Pull request merged | **Merged #12**  | Push only, Deploy preview                                                 |

**Push only** pushes the session branch to `origin`. **Create PR** opens a pull
request from the session branch into its base branch (the branch it was created
from, or the repository's default), titled after the session. Push the branch
before creating the pull request, or ask the agent to push it.

The pull request's number, URL and state are kept on the session, so the session
row, the share link and the CLI all show it.

## Checks

The **Checks** tab shows the pull request (open, draft, merged or closed, and
whether GitHub considers it mergeable) and every check on its latest commit: GitHub
Actions runs, other check runs and commit statuses. It refreshes every 20 seconds
while the tab is visible. Checks are read with your GitHub access, or the host's
when you have not linked GitHub.

For a failing GitHub Actions job, the tab shows the end of the job's log (the last
60 lines). **Fix with agent** queues one prompt with the failing checks and their
log excerpts, asking the agent to find the cause and fix it. It goes into the
session's chat like any other prompt.

If there is no pull request yet, the tab says so; checks appear once one exists.

## Merge

**Squash and merge** merges the pull request on GitHub with a squash commit and
marks the session **done**. The API also accepts a rebase merge
(`{"method": "rebase"}`); merge commits are not offered.

After a merge, archive the session to remove its worktree. The branch stays, and
any [preview environment](/greenhouse/previews/#teardown) is torn down with it.

## From the CLI and agents

```bash
orchard sandbox session list leafy
```

lists each session's branch, diffstat and pull request. Agents connected over MCP
can open a pull request with `create_sandbox_session_pr`; see
[Automating Greenhouse](/greenhouse/automation/).
