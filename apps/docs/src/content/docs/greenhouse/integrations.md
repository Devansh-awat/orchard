---
title: Start sessions from GitHub, Linear, and Slack
description: Start a Greenhouse session from an issue, a /greenhouse comment, or a Slack message, on a machine you host. You must link your account on the other service first.
sidebar:
  order: 11
---

To start a Greenhouse session without opening the workspace, comment on an issue or send a chat message. Greenhouse creates the session on a machine you host, sends your request to the agent, and replies with a link.

## Prerequisites

- A running machine that you host. These integrations do not use machines you were invited to, and they do not start a stopped machine.
- The integration set up on your instance. For the operator steps, refer to [Run Greenhouse](/operate/greenhouse/#set-up-integrations).
- Your account on the other service linked to your Orchard account. Orchard does not match accounts by email address.

## Link your accounts

| Service | How to link it                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub  | In **Account settings** > **GitHub and Tailscale**, sign in with GitHub.                                                                                                                                                                                                       |
| Linear  | In **Account settings** > **Greenhouse** > **Connected accounts**, select **Connect** next to **Linear** and paste a personal API key. In Linear, create the key under **Settings** > **Security and access** > **Personal API keys**. Read access is enough to select issues. |
| Slack   | In Slack, run `/greenhouse link`. Open the link that Slack shows you while signed in to Orchard, and confirm. The link works once and expires after 10 minutes.                                                                                                                |

A Linear or Slack account can be linked to one Orchard user. To unlink Slack, run `/greenhouse unlink`, or select **Unlink** in **Settings** > **Integrations**. To disconnect Linear, select **Disconnect** in **Connected accounts**.

## Start a session from the home page

1. On the home page, select **Start from an issue** in the prompt box.
2. Search for an issue, or enter its reference.
3. (Optional) Enter a prompt.
4. Start the session.

The issue picker accepts these references:

| Service | Reference                                                                               |
| ------- | --------------------------------------------------------------------------------------- |
| GitHub  | `owner/repo#123`, the issue's URL, or `#123` for the repository the session starts from |
| Linear  | The issue's key, such as `ENG-42`, or its URL                                           |

Greenhouse fetches the issue with your access and gives it to the agent as quoted content, not as instructions.

:::note
Issues on public repositories can be written by anyone. If the issue's author is not the host or a guest of the machine, only the host can start a session from it.
:::

## Start a session from a GitHub issue

Comment on an issue in a repository where your instance's GitHub App is installed:

```text
/greenhouse fix this and add a regression test
```

Greenhouse then does the following:

1. It checks that your GitHub account is linked to an Orchard user. It ignores comments from other accounts and from bots.
2. It picks one of your running machines that has the repository cloned. If none has it, it uses the machine of your most recent session in that repository.
3. It starts a session with the issue and your text as the prompt.
4. It replies on the issue with a link to the session. If it cannot start a session, the reply asks you to open Greenhouse in Orchard.

Greenhouse ignores comments on pull requests.

## Start a session from a Linear issue

Comment on a Linear issue:

```text
/greenhouse in acme/storefront: implement this behind a feature flag
```

Linear issues have no repository attached. Greenhouse picks the repository in this order:

1. A repository you mention as `owner/name`, on one of your running machines.
2. The name of a repository cloned on one of your running machines.
3. The machine and repository of your most recent session.

Greenhouse replies in the comment's thread with a link, or with the reason it could not start a session. It posts the reply with your Linear key, so the reply appears as you.

## Start a session from Slack

Run the slash command:

```text
/greenhouse add rate limiting to the login endpoint in acme/api
```

You can also mention the app in a channel or thread:

```text
@Greenhouse the export button is broken on Safari, can you look at storefront?
```

Greenhouse picks the machine and repository in the same order as for Linear. It posts in the thread:

```text
@you started Fix the export button on my-machine (storefront). I will post here when the agent stops.
```

When the agent finishes its turn, Greenhouse follows up in the thread. It stops watching after six hours.

The app must be in the channel to post there. If it is not, the slash command still starts the session and tells you privately.

If you have not linked your account, Slack shows you a link to do so and does not start a session.

To list the commands, run `/greenhouse help`.

## Limits

You can start up to five sessions per minute from these integrations. Greenhouse records each delivery, so a repeated delivery does not start a second session.

## Related resources

- [Automate Greenhouse](/greenhouse/automation/)
- [Share a machine](/greenhouse/sharing/)
