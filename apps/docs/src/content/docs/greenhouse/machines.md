---
title: Machines
description: A Greenhouse machine is a Linux environment that belongs to one host and one organization. Learn what each runner provides, what persists, and which limits apply.
sidebar:
  order: 3
---

A machine is the Linux environment that your sessions run on. It belongs to the person who created it, called the **host**, and to that person's organization.

## Status

| Status   | Meaning                                                                   |
| -------- | ------------------------------------------------------------------------- |
| Creating | The runner is provisioning the machine.                                   |
| Starting | The machine is booting, or resuming after a stop.                         |
| Running  | The machine is ready. Sessions, terminals, SSH, and previews work.        |
| Stopping | The machine is shutting down. Orchard keeps its disk or snapshot.         |
| Stopped  | The machine is not running.                                               |
| Deleting | Orchard is removing the machine and everything on it.                     |
| Error    | The machine failed. The status message states why.                        |

A machine can also show **Applying** while Orchard carries out a change, or **Apply failed** if the change did not succeed. For more information, refer to [Troubleshooting Greenhouse](/greenhouse/troubleshooting/#a-machine-shows-apply-failed).

## Runners

The runner is fixed when you create the machine.

### Kubernetes

The machine is a pod on the instance's cluster, managed by the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller. On clusters with Kata Containers, each machine is a lightweight virtual machine with its own kernel.

- **Disk:** A persistent volume mounted at `/persist`, 10 GiB by default. It holds your home directory, repositories, worktrees, agent history, and SSH host keys. A stop does not remove it. The rest of the root filesystem is not kept across a stop.
- **Network:** Internet egress only. Inbound connections come only from the Orchard server.
- **Previews:** Private to people with access to the machine.
- **Forking:** Available when the cluster can snapshot the machine's storage.

### Vercel

The machine is a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) on the operator's Vercel account.

- **Disk:** `/persist` is a Vercel drive that belongs to the machine, 50 GiB by default. Orchard deletes the drive only when you delete the machine. If Vercel loses the sandbox, the next start creates a new sandbox with the same drive.
- **Snapshots:** Stopping the machine snapshots the rest of its filesystem. Orchard keeps the last three snapshots. They do not expire.
- **Processes:** Running processes do not survive a stop. Orchard restarts its own services on the next start. You restart your dev servers.
- **Time limit:** Vercel stops a sandbox after a timeout, 60 minutes by default. Orchard extends the timeout in 30-minute steps while the machine is in use. If Vercel stops the machine, it shows **Stopped** with the message `Stopped by provider timeout`.
- **Network:** Ports are reachable from the internet. The agent server and the SSH bridge require a per-machine secret. Preview ports are public.
- **GitHub:** Vercel's egress proxy adds the host's GitHub token to requests to `github.com` and `api.github.com`. The token is not stored in the machine.
- **Forking:** Requires Vercel drive forks on the operator's plan. Without them, the fork option is hidden for machines with a drive.

## Image and tools

A new machine starts from Orchard's machine image on Kubernetes, and from Vercel's universal image on Vercel, unless the operator selected another image.

Orchard's image includes `sshd`, `git`, `tmux`, `ripgrep`, Node.js 22, Claude Code, opencode, fx, and Codex. On another image, Orchard installs what is missing on boot.

Your shell runs as the `dev` user. The `dev` user has passwordless `sudo`.

## Repositories

Repositories live in the home directory as `~/<name>`. The home directory is `/persist/home`.

To add a repository, select **Add repository** in the sidebar. The sheet has three modes: **Clone**, **New**, and **Open folder**. Only the host can use it. Guests can start a new empty repository from the home page.

To add a repository from the CLI, run the following command:

```bash
orchard sandbox repo add my-machine https://github.com/acme/api
```

Clones use the host's GitHub access and run in the background. The repository named at creation logs to `~/.clone.log`.

## Setup script

The setup script of a machine runs as `dev` on first boot. It logs to `~/.setup.log`. It runs again on later boots until it succeeds once.

Use it for language runtimes, global tools, and dotfiles. To edit it, go to **Settings** > **Machine**. From the CLI, use `orchard sandbox update --setup`.

To run commands for each session of a repository, use [`.orchard/greenhouse.json`](/greenhouse/scripts/) instead.

## Agent credentials

Your Claude token, OpenAI key, and AI Gateway key are stored on your account. Every machine you host uses them. When you change one, Orchard syncs it to those machines. Guests do not need their own credentials, because they run the host's agent.

Some sign-ins stay on one machine instead of your account. These are the ChatGPT sign-in for Codex, and the fx sign-ins.

## Actions by role

| Action | Host | Guest | Read-only guest | Organization admin |
| ------ | ---- | ----- | --------------- | --------- |
| Start  | Yes  | Yes   | No              | Yes       |
| Stop   | Yes  | No    | No              | Yes       |
| Delete | Yes  | No    | No              | Yes       |
| Fork   | Yes  | No    | No              | No        |

For all permissions, refer to [Share a machine](/greenhouse/sharing/#what-each-role-can-do).

A stop ends running agents, terminals, and dev servers. Files on disk remain.

Deleting a machine removes everything on it, including unpushed branches. On Vercel, it also removes the drive and snapshots. You cannot recover them.

## Forking

Forking creates a new machine with a copy of the disk and the same sessions. The host of the source machine becomes the host of the copy.

Only the host can fork a machine, because the copy contains the host's home directory and credentials. The fork counts against your machine limit.

| Runner     | How the copy is made                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Kubernetes | A volume snapshot of the home volume, restored into the volume of the new machine. A forked machine has 30 minutes to start, instead of 10. |
| Vercel     | A fork of the last saved snapshot and a fork of the drive. Stop the machine first to include recent changes.                                |

To fork a machine, open the machine menu and select **Fork machine**. From the CLI, run the following command:

```bash
orchard sandbox fork my-machine --name my-machine-experiment
```

The default name is `<name>-fork`.

## Limits

The operator sets these limits. The following values are the defaults.

| Limit               | Default    | Behavior                                                                                                                       |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Machines per person | 1          | Creating or forking past the limit fails. Superadmins can change the limit per person, and have no limit themselves.           |
| Idle stop           | 60 minutes | Orchard stops a running machine with no terminal or SSH activity for this long. A working agent counts as activity.             |
| Maximum lifetime    | 168 hours  | Orchard stops a machine this long after its last start, whether or not it is active. Orchard does not delete it.               |
| People per machine  | 50         | Fixed.                                                                                                                         |
| Active share links  | 50         | Fixed, per machine.                                                                                                            |

The audit log records each stop caused by a limit.
