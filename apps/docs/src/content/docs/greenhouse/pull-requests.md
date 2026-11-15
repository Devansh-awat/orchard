---
title: Commit, push, and merge
description: Commit a Greenhouse session's changes, open a GitHub pull request, follow its checks, and merge it. Pushes and merges use your own linked GitHub account.
sidebar:
  order: 8
---

When a session's work is ready, you can take it all the way to your repository without leaving the workspace: commit the changes, open a pull request, follow its checks, and merge it. Each step runs with your own GitHub account, so the history shows who did what.

## Prerequisites

- A GitHub account linked to Orchard. Link it in **Account settings** > **Connections**. Until you link it, the pull request button reads **Link GitHub to push**. You can still commit.
- [Host or guest access](/greenhouse/sharing/#roles) to the machine. Read-only guests cannot commit or push.

Pushes, pull requests, and merges use your own GitHub account, on any machine you can edit.

## 1. Commit

1. In the right panel, select **Changes**.
2. Enter a commit message.
3. Select **Commit**, or press `CMD + ENTER`. This commits all changes in the session's worktree.

To amend the last commit, open the menu next to **Commit** and select **Amend last commit**.

Your commit carries your name and your GitHub `noreply` address. If you have not linked GitHub, it carries your Orchard name and email.

## 2. Open a pull request

Select **Create PR** in the title bar. To open a draft, open the menu next to the button and select **Create draft pull request**.

Greenhouse opens a pull request from the session's branch into its base branch. The base branch is the branch that the session started from, or the repository's default branch. If the branch has no upstream, or has unpushed commits, Greenhouse pushes it first. Uncommitted changes are not included.

To push without opening a pull request, select **Push only** in the same menu.

The button then shows the pull request's state:

| State               | Button          | Menu                                                                                      |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| No pull request     | **Create PR**   | **Create pull request**, **Create draft pull request**, **Push only**, **Deploy preview** |
| Pull request open   | **View PR #12** | **Push only**, **Squash and merge**, **Deploy preview**                                   |
| Pull request merged | **Merged #12**  | **Push only**, **Deploy preview**                                                         |

## 3. Review checks

Select **Checks** in the right panel. The tab shows the pull request's state and every check on its latest commit. It refreshes every 20 seconds while the tab is open.

For a failed GitHub Actions job, the tab shows the last 60 lines of its log.

**Fix with agent** queues one prompt with the failed checks and their log excerpts. The prompt goes to the session's chat.

Greenhouse reads checks with your GitHub access, or with the host's access if you have not linked GitHub.

## 4. Merge

Open the pull request menu and select **Squash and merge**. Greenhouse merges the pull request on GitHub with a squash commit.

The merge endpoint also accepts `{"method": "rebase"}`. Greenhouse does not offer merge commits.

## 5. Archive the session

Archive the session to remove its worktree. The branch stays, unless **Delete branch on archive** is on in **Settings** > **Git**. Archiving also removes the session's [preview environment](/greenhouse/previews/#remove-a-preview-environment).

## Commit attribution

When other people prompted the agent in a session, commits from the **Changes** tab carry a `Co-authored-by` trailer for each of them.

Commits that the agent makes belong to the host, because the agent runs as the host. Each carries a `Co-authored-by` trailer for everyone else who prompted the agent in that turn.

Greenhouse adds these trailers with a `prepare-commit-msg` hook that it sets on the session's worktree only. The hook runs the repository's own hooks first, and it also applies to `git commit` in a terminal.

## Commit options in the API

The commit endpoint, `POST /apiv1/sandboxes/:id/git/commit`, can also commit only tracked files or a list of files, and can add a sign-off line. `POST /apiv1/sandboxes/:id/git/uncommit` undoes the last commit.

## Related resources

- [Git identity](/greenhouse/sharing/#git-identity) - Learn whose name and token each git operation uses on a shared machine.
- [Automate Greenhouse](/greenhouse/automation/) - Open pull requests from an agent or a script with MCP tools, the CLI, or the API.
