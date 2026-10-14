---
title: Machines
description: Runners, lifecycle, what persists, forking and the limits a machine runs under.
sidebar:
  order: 3
---

A machine is the box your sessions run on. It belongs to the person who created
it (its **host**) and to that person's organization.

## Status

| Status       | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| **Creating** | Just created; the runner is provisioning it.                                   |
| **Starting** | Coming up, or resuming after a stop.                                           |
| **Running**  | Ready. Sessions, terminals, SSH and previews work.                             |
| **Stopping** | Shutting down. Its disk or snapshot is kept.                                   |
| **Stopped**  | Not running and not costing compute. Start it to carry on.                     |
| **Deleting** | Being removed with everything on it.                                           |
| **Error**    | Something failed. The message says what; starting it again is usually the fix. |

Next to the status, a machine can show **Applying** while Orchard is still
carrying out a change you asked for (starting, stopping, syncing credentials), and
an **apply error** if that change failed and is being retried. See
[Troubleshooting](/greenhouse/troubleshooting/#applying-and-apply-errors).

## Runners

### Kubernetes

The machine is a pod in the instance's own cluster, managed through the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller. On
clusters with Kata Containers each machine is a lightweight VM, so code inside it
does not share a kernel with anything else.

- **Disk.** A persistent volume (10 GiB unless your operator changed it) mounted
  at `/persist`. Your home directory, repositories, worktrees, agent history and
  SSH host keys live there and survive every stop and start.
- **Network.** Internet egress only. Nothing on the internet can reach the
  machine; Orchard's server tunnels SSH, terminals and previews to it.
- **Previews.** Private. A preview URL works only for people with access to the
  machine (see [Previews and ports](/greenhouse/previews/)).
- **Forking.** Available when the cluster's storage supports volume snapshots.

### Vercel

The machine is a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) on the
operator's Vercel account.

- **Disk.** Two layers. `/persist` (your home directory, repositories, worktrees,
  agent history and SSH host keys) lives on a Vercel drive that belongs to the
  machine alone (50 GiB unless your operator changed it). The drive is kept until
  the machine is deleted, however long the machine sits stopped, and it survives
  even if Vercel loses the sandbox itself: the next start puts the machine on a new
  sandbox with the same drive. Everything outside `/persist` is kept in snapshots:
  stopping the machine snapshots the rest of its filesystem, so packages installed
  with `apt` or `npm -g` and anything under `/etc`, `/usr/local` and `/root` come
  back when it starts. Orchard keeps the last three snapshots and they never
  expire. Running processes do not come back; Orchard restarts its own services on
  start, and your dev servers need starting again.
- **Older machines.** A machine created before drives existed keeps its home in its
  snapshot until its next start. That start copies the home onto a new drive
  before anything else runs, and the machine uses the drive from then on. The old
  copy stays in the snapshot, untouched.
- **Start time.** A new machine is ready in about 15 to 20 seconds. A stopped
  machine resumes in about 7 seconds, and stopping takes about 7 seconds.
- **Time limit.** Vercel stops a sandbox after a timeout (60 minutes unless your
  operator changed it). Orchard extends it in 30 minute steps while the machine is
  in use. If Vercel stops it anyway, the machine shows **Stopped** with the message
  `Stopped by provider timeout`; start it again to resume.
- **Network.** Ports are reachable from the internet by design. The agent server
  and the SSH bridge require a per-machine secret; preview ports are public URLs.
- **GitHub.** The GitHub token used by the agent is injected by Vercel's egress
  proxy on requests to `github.com` and `api.github.com`, so it is never stored
  inside the machine.
- **Previews.** Public. Anyone with the URL can open them.
- **Forking.** Copies the last saved snapshot and forks the machine's drive into a
  new drive for the copy, and is ready in a few seconds. The fork gets its own
  agent password and SSH bridge token. Drive forks are a Vercel feature not every
  plan has; without it, machines with a drive cannot be forked and the option is
  hidden.

## Image and tools

A new machine starts from Orchard's machine image on Kubernetes and Vercel's
universal image on Vercel, unless your operator picked another. The Orchard image
already has `sshd`, `git`, `tmux`, `ripgrep`, Node.js 22 and every agent: Claude
Code, opencode, fx and Codex. On any other image Orchard installs whatever is
missing on first boot and leaves the rest alone. The `dev` user has passwordless `sudo`, so install anything else
you need.

## Repositories

Repositories are cloned into the home directory as `~/<name>`. The one you gave
at creation is cloned on first boot. The host adds more from the sidebar (**Add
repository**) or the CLI:

```bash
orchard sandbox repo add leafy https://github.com/you/api
orchard sandbox repo list leafy
```

Clones run in the background and log to `~/.clone.log`. A failed clone never
stops the machine. Clones use the host's GitHub access, so private repositories
work once the host has linked GitHub.

## Machine setup script

A machine can carry a setup script that runs **once**, as `dev`, on its first
boot: install a language runtime, configure dotfiles, log in to a registry. Its
output goes to `~/.setup.log`, and once it succeeds it never runs again on that
machine. Set it when creating the machine from the CLI (`--setup file.sh`) or
change it later in the machine settings.

For commands that should run for **every session** of a repository, such as
installing dependencies in a fresh worktree, use
[`.orchard/greenhouse.json`](/greenhouse/scripts/) instead.

## Start, stop and delete

| Action | Host | Guest | Read-only guest | Org admin |
| ------ | ---- | ----- | --------------- | --------- |
| Start  | Yes  | Yes   | No              | Yes       |
| Stop   | Yes  | No    | No              | Yes       |
| Delete | Yes  | No    | No              | Yes       |

Stopping kills running agents, terminals and dev servers but keeps everything on
disk (on Vercel, on the drive and in the snapshot). Sessions and their branches are all there on the next
start.

**Deleting a machine deletes everything on it.** Anything not pushed is gone.
Push your branches first. On Vercel that includes the machine's drive and its
snapshots: once the sandbox is deleted, Orchard deletes the drive too, and there
is no way to get either back. Deleting is the only thing that ever removes a
drive; stopping, starting, timeouts and forks never do.

## Forking

Forking makes a new machine you own with the same disk and the same sessions:
repositories, worktrees, branches, installed packages and settings. Use it to try
something risky without touching the original, or to give an experiment its own
box.

Only the host can fork a machine, because the copy carries their home directory
and everything stored in it. The fork counts against your machine limit.

```bash
orchard sandbox fork leafy --name leafy-experiment
```

The default name is `<name>-fork`. Sessions come across with their worktrees and
branches; each starts a fresh agent chat on first use.

| Runner     | How it copies                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kubernetes | A volume snapshot of the home volume, restored into the new machine's volume. Only offered when the cluster can snapshot that storage.                                   |
| Vercel     | A fork of the last saved snapshot plus a fork of the machine's drive. Stop the machine first to include recent changes. Needs Vercel drive forks on the operator's plan. |

On Kubernetes a copy can take a while to start, because the volume has to be
restored first. A forked machine gets 30 minutes to come up before it is marked
as failed, instead of the usual 10, and the snapshot is deleted once the copy is
running on its restored volume.

## Agent credentials

Your Claude Code token and OpenAI key are stored once on your account and used by
every machine you host. Changing or clearing them queues a credential sync for
each of those machines; a shell that was already open keeps the old value until
the machine restarts. Guests never need their own: they run the host's agent.

```bash
orchard sandbox credentials status
orchard sandbox credentials clear --claude
```

## Limits

Your operator sets these; the defaults are below.

| Limit               | Default    | What happens                                                                                                                                  |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Machines per person | 1          | Creating or forking past it is refused. Admins can raise it per person; superadmins have no cap.                                              |
| Idle stop           | 60 minutes | A running machine with no terminal or SSH activity for this long is stopped. A working agent counts as activity, so long agent runs are safe. |
| Maximum lifetime    | 168 hours  | A machine running this long since its last start is stopped, active or not. It is not deleted.                                                |
| Shared with         | 50 people  | Per machine.                                                                                                                                  |
| Active share links  | 50         | Per machine.                                                                                                                                  |

A stop by either limit is recorded in the audit log.
