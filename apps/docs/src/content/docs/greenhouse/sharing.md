---
title: Sharing and multiplayer
description: Invite teammates to a machine as guests, what each role can do, and what sharing gives them.
sidebar:
  order: 10
---

A machine can be shared with people in its organization. They join as
**guests**, and the session becomes a group chat with an agent in it: everyone
sees the same thread, prompts the same agent, edits the same files and can watch
each other's terminals, live.

Sharing is powerful because the machine is the host's: their agent, their Claude
subscription, their files. Read [what sharing gives your guests](#what-sharing-gives-your-guests)
before you invite anyone.

## Roles

| Role                | Who                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Host**            | The person who created the machine. Platform superadmins have the same access.                                              |
| **Guest**           | Someone the host invited. Works on the machine alongside the host.                                                          |
| **Read-only guest** | Someone the host invited with **Read-only guest** ticked. Watches, does not touch.                                          |
| **Org admin**       | An admin of the machine's organization who was not invited. Can see the machine and start, stop or delete it, nothing more. |

An org admin who is also invited gets the role they were invited with, plus start, stop and delete.

### What each role can do

| Action                                                                  | Host | Guest | Read-only guest | Org admin |
| ----------------------------------------------------------------------- | :--: | :---: | :-------------: | :-------: |
| See the machine in lists: name, status, runner, owner                   | Yes  |  Yes  |       Yes       |    Yes    |
| See sessions, transcripts, comments, diffs, files and who is here       | Yes  |  Yes  |       Yes       |    No     |
| Watch other people's terminals and the script output                    | Yes  |  Yes  |       Yes       |    No     |
| Open previews                                                           | Yes  |  Yes  |       Yes       |    No     |
| Prompt the agent, queue prompts, send reviews                           | Yes  |  Yes  |       No        |    No     |
| Comment with `/chat`, show a typing draft                               | Yes  |  Yes  |       No        |    No     |
| Edit, create, rename and delete files                                   | Yes  |  Yes  |       No        |    No     |
| Open their own terminals                                                | Yes  |  Yes  |       No        |    No     |
| Start and stop the run script                                           | Yes  |  Yes  |       No        |    No     |
| Create, archive and delete sessions and their branches; create chats    | Yes  |  Yes  |       No        |    No     |
| Commit                                                                  | Yes  |  Yes  |       No        |    No     |
| Push, pull, open pull requests and merge, with their own GitHub account | Yes  |  Yes  |       No        |    No     |
| Start the machine                                                       | Yes  |  Yes  |       No        |    Yes    |
| Stop or delete the machine, retry changes that failed to apply          | Yes  |  No   |       No        |    Yes    |
| SSH, editor links and host keys                                         | Yes  |  No   |       No        |    No     |
| Invite people, change roles, remove people                              | Yes  |  No   |       No        |    No     |
| Machine settings, agent credentials, adding repositories                | Yes  |  No   |       No        |    No     |
| Attach projects and deploy preview environments                         | Yes  |  No   |       No        |    No     |
| Create and revoke read-only share links, fork the machine               | Yes  |  No   |       No        |    No     |

Anyone can leave a machine they were invited to.

These rules are enforced by the server on every request, every terminal and
every message on the live connection, not just hidden in the interface. A
read-only guest's edits to a shared file are dropped by the server even if their
browser sends them.

Reading files through the editor and the diff view, and file operations, are limited to
the session's worktree and the repositories in the home directory. The check runs
inside the machine on the real path, so a symlink in a repository that points at
`~/.git-credentials`, `~/.config` or anywhere outside the workspace is refused,
and so is anything directly under a dot directory of the home directory. Guests
with a terminal can of course still read whatever the machine holds; this is what
keeps read-only guests and share links to the code.

## Invite people

In the workspace, open **Share machine** from the session menu or the machine
menu. Search for someone in the organization by name or email, tick
**Read-only guest** if they should only watch, and invite them.

Only people in the machine's organization can be invited, and a machine can be
shared with up to 50 people. Change someone's role or remove them from the same
sheet. Removing someone, or lowering their role, takes effect immediately: their
open workspace is disconnected, and terminals and previews they had open stop
within seconds.

The first time you share a machine, the sheet asks you to read the disclosure
below and tick **I understand** before you can invite anyone.

**Copy share link** in the session menu copies a link to the session for people
who are already on the machine. To show work to someone who is not, use a
[read-only share link](#read-only-share-links).

## What sharing gives your guests

Greenhouse does not try to hide what a shared machine is. It says it, on both
sides.

**What the host is told** in the share sheet, before the first invite:

> Guests can run your agent on your Claude subscription, read and change every file on this machine including credentials stored in it, use terminals, and see anything you type in shared terminals.

**What a guest is told** the first time they open the machine, before they can
do anything (they must press **Continue**):

> This machine belongs to <host>. They can see everything you do here, including your terminal sessions. When you push, your GitHub token is used for that command inside their machine.

A read-only guest sees only the first two sentences, since they cannot push.

Taken literally, that means:

- **The agent is the host's.** A guest's prompts run on the host's Claude
  subscription, inside the host's machine. Anything the agent can do, a guest can
  ask it to do.
- **The files are the host's.** A guest with a terminal can read anything on the
  machine, including credentials the host keeps there: agent tokens, the
  [attached project](/greenhouse/projects/) env files, a GitHub credential the
  agent uses, anything in the host's dotfiles.
- **Terminals can be watched.** Whatever the host types in a terminal, a guest
  can watch, and the other way round.
- **The agent's Orchard access is the host's.** The agent holds an Orchard MCP
  token for the host, issued for this machine and limited to its organization. A
  guest can read it and act as the host in that organization (projects,
  deployments, variables) until it is rotated. Removing a guest, or making them
  read-only, revokes it and issues a new one; the agent's Orchard tools pick it
  up when the machine next starts.
- **A guest's own GitHub token is used inside the host's machine** when the guest
  pushes. A push from the workspace gets it for that one command, and it is never
  written to the machine's disk or git config. In the guest's own terminals it
  sits in the shell's environment while the terminal is open, where the host,
  other guests and the agent can read it. Either way the command runs on a
  machine the host controls.
- **Org admins cannot look in.** An admin of the machine's organization can see
  that the machine exists and start, stop or delete it, but not its sessions,
  transcripts, files, diffs, terminals, previews or the people on it, unless you
  invite them. Platform superadmins keep host access for emergencies.
- **Removing a guest is not a reset.** Their terminals are ended, the agent's
  Orchard token is rotated, and the agent server password and SSH bridge token
  change. The agent server restarts with the new password a few seconds later,
  which stops any agent run in progress on the machine. Anything else they
  changed or copied while they had access stays changed or copied. Rebuild the machine if you no longer trust
  someone who had access.

Share a machine with people you would hand your laptop to. For anyone else, use a
[read-only share link](#read-only-share-links), which shows the transcript and the
diff and nothing else.

## Everyone commits as themselves

Every git write made through Greenhouse runs with the identity of the person who
made it, not the host's:

- **Commits** from the Changes tab use your name and email: from your linked
  GitHub account (with its `noreply` address), or your Orchard name and email if
  GitHub is not linked.
- **Push, pull, pull requests and merges** authenticate with your own GitHub
  token, injected into that one command through an inline credential helper and
  never stored on the machine.
- **Without a linked GitHub account** you can still commit locally under your own
  name; pushing and pull requests show **Link GitHub to push** until you link it.

Commits record everyone who took part: when several people prompted the agent in
a session, the commit carries a `Co-authored-by` trailer for each of them.

The **agent** is the exception. It runs as the host, so commits and pushes it
makes on its own are the host's, with a trailer for each person who prompted it
in that turn. See
[Pull requests and checks](/greenhouse/pull-requests/#commit).

Every prompt is attributed to whoever sent it, including the first one: a
session started with a prompt, from the composer, the CLI, MCP, a GitHub or
Linear `/greenhouse` comment or Slack, shows that prompt as its creator's.

### Terminals are per person

Everyone in a session gets their own terminals. A guest's terminal is set up
with the guest's git name and email and a credential helper for the guest's
GitHub token, so `git commit` and `git push` typed there are the guest's too. The
token lives in that terminal's environment while it is open, which is the
"used inside their machine" in the guest's notice: the host could read it from
the running shell.

Anyone in the session can open someone else's terminal to watch it, but only
read only: you only ever type in your own shells. That is also why the host is
told guests can see what they type in shared terminals.

## Working together

**Presence.** Avatars in the top bar show who is on the machine, dots on session
rows show who is in which session, and dots on tabs and in the file tree show who
has a file open.

**Follow.** Click someone's avatar to follow them: your view jumps to their
session, tab and file and keeps up as they move. Click again to stop.

**Live typing.** While someone writes a prompt you see `Alex is typing…` above the
composer, with their draft. Drafts are never stored.

**Attributed prompts.** Every prompt in the thread shows who sent it, including
prompts sent from the CLI, MCP, Slack or an issue. Ask the agent something and
everyone in the session sees it was you.

**Comments.** `/chat <message>` posts to the people in the session without
prompting the agent. Comments are kept with the session.

**Co-editing.** Two people with the same file open edit it together, with each
other's cursors and selections in colour. The agent's edits on disk are merged in.

**Notifications.** When the agent finishes a turn and is waiting, the host and
everyone who prompted that session in the last six hours get a **Session needs
input** notification on their personal notification channels, unless they are
looking at the machine right now.

## Read-only share links

A share link shows a session's transcript and its changes to someone in your
organization who is not on the machine, without giving them any access to it.
Use it to ask for a review or show what the agent did.

- It shows the latest messages of the agent chat (text only, with who sent each
  prompt), the changed files and the diff. No files, terminals, previews or
  machine controls.
- It covers one session, or every active session on the machine.
- The person opening it must be signed in to Orchard and a member of the machine's
  organization. Organization guests cannot open it.
- It expires after 7 days by default, or any number of hours from 1 to 720.
- The link's token is shown once, when you create it. Orchard stores only a hash
  of it.
- Revoking a link stops it on the next request. Deleting the machine stops all of
  them.
- A machine can have up to 50 active links. Each use is recorded in the audit log.

Only the host creates and revokes share links.

```bash
orchard sandbox share create leafy --session fix-login --expires-in 48
orchard sandbox share list leafy
orchard sandbox share revoke leafy <link-id>
```

The link opens at `https://<your orchard>/share/sandbox#<token>`. The token sits
after the `#`, so browsers never send it to the server and it stays out of
access logs; the page sends it to the API in an `X-Orchard-Share-Token` header.
Links in the older `/share/sandbox/<token>` form keep working.
