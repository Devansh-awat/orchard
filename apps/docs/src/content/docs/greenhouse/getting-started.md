---
title: Get started
description: Create a machine, pick a runner and start your first agent session.
sidebar:
  order: 2
---

Greenhouse lives at **Greenhouse** in the dashboard (`/sandboxes`). If it is not
there, it is switched off on your instance; ask an admin to turn it on
([Running Greenhouse](/operate/greenhouse/)).

## Before you start

Three things are worth setting up once, under **User settings**:

| What                    | Where                                              | Why                                                                   |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| An SSH key              | **Sandbox** (or `orchard ssh-identity`)            | Required to create a machine. It is how editors and `ssh` reach it.   |
| Your Claude Code token  | **Sandbox** (or `orchard sandbox credentials set`) | The agent runs on it. Without it the agent cannot answer.             |
| A linked GitHub account | **GitHub and Tailscale**                           | Private clones, pushing, pull requests, checks and issues all use it. |

The Claude token comes from `claude setup-token` on any machine with Claude Code
installed. Pipe it in rather than pasting it into your shell history:

```bash
claude setup-token | orchard sandbox credentials set --claude -
```

An OpenAI key for Codex goes the same way with `--openai -`. Tokens are encrypted
at rest and never shown again; the API only reports whether each one is set.

If you would rather not manage an SSH key by hand, run
`orchard sandbox ssh-config --install` once. It generates a key, registers it as
an identity and wires up your SSH config in one step (see
[Open in your editor](/greenhouse/editors/)).

## Create a machine

On the Greenhouse home page, choose **New machine**.

- **Runs on.** Pick a runner. Only runners the instance has available are
  offered, and the instance default is preselected. A runner that is switched off
  or misconfigured is listed underneath with the reason.
- **Name.** Optional. It must be a lowercase DNS label (letters, digits and
  hyphens, up to 63 characters) and is unique among your machines. Leave it empty
  and one is generated.
- **Repository.** Optional. An `https://` Git URL cloned into the home directory
  on first boot. You can add more repositories later.
- **SSH key.** Which of your identities the machine trusts. Every identity on
  your account is trusted for SSH once the machine is running; this picks the one
  shown as attached.

The machine appears with the status **Creating**, then **Starting**, then
**Running**. While it boots, the workspace shows which step it is on: system
packages, Node.js, the coding agents, storage, your user account and finally the
agent server. A first boot on a bare image takes a few minutes because it
installs those tools; later starts skip what is already there.

From the CLI:

```bash
orchard sandbox create leafy --repo https://github.com/you/app --runner kubernetes
orchard sandbox list
```

`--runner` is optional and falls back to the instance default.

Most people get one machine. If **New machine** says you have reached the limit,
an admin can raise it for you.

## Start your first session

The home page opens on a launch composer: **What should we build?**

1. Type what you want done, or paste an issue.
2. Check the chips under the box:
   - **Machine.** Which machine the session runs on.
   - **Repository · branch.** Which cloned repository to branch from, and the
     base branch. The default branch is used unless you pick another.
   - **Issue.** Optional. Paste `owner/repo#123` or a Linear key such as `ENG-42`
     and the agent reads the issue before it starts. See
     [Start from GitHub, Linear and Slack](/greenhouse/integrations/).
3. Turn on **Plan first** if you want the agent to propose a plan before it
   edits anything.
4. Press **Enter**.

If the machine is stopped, Greenhouse starts it first. It then creates a worktree
on a new `orchard/<slug>` branch, opens the session and sends your prompt as the
first message. The agent starts working straight away and the session row in the
sidebar shows it as working.

Each session is independent. Start another one from the composer, or with
**⌘N** in the workspace, and the two agents work side by side on separate
branches.

From the CLI:

```bash
orchard sandbox session create leafy app --prompt "Fix the flaky login test"
orchard sandbox session list leafy
```

## What next

- Watch the agent work, review its diff and leave comments in
  [the workspace](/greenhouse/workspace/).
- Add a `.orchard/greenhouse.json` so every session installs dependencies and
  can start your dev server with one click: [Setup and run scripts](/greenhouse/scripts/).
- Push and open a pull request: [Pull requests and checks](/greenhouse/pull-requests/).
