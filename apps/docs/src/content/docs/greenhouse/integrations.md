---
title: Start from GitHub, Linear and Slack
description: Start sessions from issues and chat, and link your GitHub, Linear and Slack accounts.
sidebar:
  order: 11
---

A session does not have to start in the browser. Hand Greenhouse an issue, or ask
for something in Slack, and it starts a session on one of your machines, sends the
request to the agent and tells you where to find it.

Each of these needs your account on the other side linked to your Orchard
account first. Linking is explicit, done by you, once. Orchard never matches
accounts by email address.

| Service | How you link it                                               | What it enables                                               |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| GitHub  | **User settings → GitHub and Tailscale**, sign in with GitHub | Issues in the composer, `/greenhouse` on issues, pushes, PRs  |
| Linear  | **User settings**, paste a personal Linear API key            | Linear issues in the composer, `/greenhouse` on Linear issues |
| Slack   | Run `/greenhouse link` in Slack and confirm in Orchard        | `/greenhouse` and mentions in Slack                           |

Your instance's operator decides which of these are set up at all; see
[Running Greenhouse](/operate/greenhouse/#integrations).

## Issues in the composer

The **Issue** chip on the launch composer takes:

- a GitHub issue: `owner/repo#123`, its full URL, or just `#123` for the
  repository the session is branching from;
- a Linear issue: its key, such as `ENG-42`, or its URL.

Greenhouse fetches the issue with your own access, puts its title, labels and body
in front of your prompt, and names the session after it. With no prompt of your
own, the agent is simply asked to work on the issue.

The issue text goes to the agent clearly marked as quoted content, not
instructions, because issues on public repositories can be written by anyone. For
the same reason, **if the issue was written by someone who is not the host or a
guest of the machine, only the host can start a session from it**. A guest who
tries gets an error saying so.

## GitHub: `/greenhouse` on an issue

Comment on an issue in any repository where your instance's GitHub App is
installed:

```
/greenhouse fix this and add a regression test
```

Orchard then:

1. Checks that the commenter's GitHub account is linked to an Orchard user.
   Comments from anyone else, and from bots, are ignored.
2. Picks one of **the commenter's own machines**: a running one with that
   repository cloned, or failing that the machine of their most recent session in
   it.
3. Starts a session there with the issue and the text after `/greenhouse` as the
   prompt.
4. Replies on the issue with a link to the session, or with the reason it could
   not start one (for example, none of your machines has the repository cloned,
   or the machine that has it is stopped).

Comments on pull requests are ignored. Each person can start up to five sessions
a minute this way.

## Linear

### Connect your API key

Create a personal API key in your Linear account settings and paste it under
**User settings** in Orchard. Orchard checks it
against Linear, stores it encrypted, and records which Linear user it belongs to.
That is the link: a Linear account can be connected to only one Orchard user.

With a key connected:

- the composer's issue chip accepts Linear keys and can search your open issues;
- `/greenhouse` comments on Linear issues start sessions for you.

Disconnect it from the same place. Removing the key also removes the link.

### `/greenhouse` on a Linear issue

Comment on a Linear issue:

```
/greenhouse in acme/storefront: implement this behind a feature flag
```

Linear has no repository attached to an issue, so Greenhouse works out which one
from your words and the issue title: mention it as `owner/name`, or by the name of
a repository cloned on one of your running machines. Failing that it uses the
machine and repository of your most recent session.

Greenhouse replies in the comment's thread with a link to the session, or the
reason it could not start one. The reply is posted with your own Linear key, so
it appears as you.

## Slack

### Link your Slack account

In any channel or DM where the Greenhouse app is available, run:

```
/greenhouse link
```

Slack shows you (and only you) a link. Open it while signed in to Orchard and
confirm. The link works once and expires after ten minutes. Your Slack account in
that workspace is now linked to your Orchard user.

`/greenhouse unlink` removes the link from Slack's side; you can also remove it in
**User settings**. A Slack account can be linked to only one Orchard user; to move
it, unlink it first.

If you use `/greenhouse` before linking, Slack replies privately with a fresh link
instead of starting anything.

### Start a session

Use the slash command:

```
/greenhouse add rate limiting to the login endpoint in acme/api
```

or mention the app in a channel or thread:

```
@Greenhouse the export button is broken on Safari, can you look at storefront?
```

Greenhouse picks a machine and repository the same way as for Linear: an
`owner/name` you mention, then a repository name cloned on one of your running
machines, then your most recent session. It posts in the thread:

> @you started Fix the export button on leafy (storefront). I will post here when the agent stops.

and, when the agent finishes its turn, follows up in the same thread with the
session link and a summary of the diff. It stops watching after six hours.

The app has to be in the channel to post there. If it is not, the slash command
still starts the session and tells you privately, with a suggestion to invite the
app.

`/greenhouse help` lists the commands.

## Where sessions run

These integrations only ever use **machines you host**. They start the session as
you, so the prompt is attributed to you in the shared thread like any other. They
never start a stopped machine: if the right machine is stopped, the reply says so
and you can start it from Greenhouse.
