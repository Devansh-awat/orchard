---
title: Troubleshooting
description: Boot phases, stuck changes, runner errors, SSH host keys, GitHub linking and previews.
sidebar:
  order: 13
---

## Greenhouse is missing or says it is not enabled

`Sandbox feature is not enabled on this server` means Greenhouse is switched off
for the whole instance. An admin turns it on under **Instance admin →
Configuration** (see [Running Greenhouse](/operate/greenhouse/#turning-it-on)).

`Sandbox feature is not enabled for your account` means the instance gates
Greenhouse per person with a product analytics feature flag, and you are not in
it yet. Ask an admin.

## The machine is taking a long time to start

While a machine boots, the workspace shows which step it is on:

| Step                              | What is happening                                        |
| --------------------------------- | -------------------------------------------------------- |
| Starting the virtual machine      | The runner is bringing the machine up.                   |
| Installing system packages        | `sshd`, `git`, `tmux` and friends, on a bare image only. |
| Installing Node.js                | Only when the image has no Node.js.                      |
| Installing coding agents          | Claude Code, Codex and opencode, only when missing.      |
| Preparing persistent storage      | Formatting (first boot) and mounting the home disk.      |
| Creating your user account        | The `dev` user, SSH host keys and SSH config.            |
| Starting SSH and the agent server | The last step before **Ready**.                          |

The first boot on a plain image installs everything and takes a few minutes.
Later starts skip what is installed already and are much quicker.

A machine that stays in **Creating** or **Starting** for ten minutes is marked
**Error** with `Sandbox did not become ready in time`, or
`Sandbox resource never appeared in the cluster` if the runner never created it.
Start it again; if it fails the same way, tell your operator.

Logs on the machine, readable from a terminal or over SSH:

| File                          | What it logs                               |
| ----------------------------- | ------------------------------------------ |
| `~/.setup.log`                | The machine setup script (first boot only) |
| `~/.clone.log`                | Repository clones                          |
| `~/.opencode-serve.log`       | The agent server                           |
| `/var/log/orchard-bridge.log` | The SSH bridge, on Vercel machines         |

## Applying and apply errors

Starting, stopping, deleting and syncing credentials are not done inline. Orchard
records what you want, queues the change, and a worker carries it out and retries
it if it fails. While a change is queued or running the machine shows
**Applying**.

If it fails, the machine shows the error and the worker keeps retrying with
increasing delays, up to ten attempts. Most errors are transient (the cluster was
busy, Vercel's API was slow) and clear on their own. One that stays, or a machine
stuck on **Applying** for more than a few minutes, needs your operator: the
change is waiting for something on the instance's side.

## A runner is unavailable

The new machine sheet lists each runner it cannot offer, with the reason:

| Reason                                                                                      | Meaning                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Kubernetes sandboxes are turned off on this server`                                        | The operator switched the runner off.                                 |
| `Vercel sandboxes are turned off on this server`                                            | Same, for Vercel.                                                     |
| `Kubernetes is not configured on this server`                                               | The server has no cluster access.                                     |
| `Vercel sandboxes need vercelToken (SANDBOX_VERCEL_TOKEN), ...`                             | Vercel credentials are incomplete; the message names what is missing. |
| `Vercel sandboxes need SECRETS_ENCRYPTION_KEY so their public ports are password protected` | The instance has no encryption key, so Vercel machines are refused.   |
| `No sandbox runner is available`                                                            | Every runner is off or misconfigured.                                 |

All of these are for your operator to fix. A runner being switched off never
strands existing machines: machines already on it keep starting, stopping and
working.

## The machine stopped on its own

| Message                               | Why                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| (none)                                | Idle stop: no terminal or SSH activity, and no agent working, for the idle limit. |
| `Stopped after reaching max lifetime` | It had been running for the maximum lifetime since it was last started.           |
| `Stopped by provider timeout`         | Vercel's own timeout stopped it.                                                  |

Start it again; everything on disk (or in the snapshot) is still there. Running
processes, including dev servers and agent turns in progress, are not.

## The machine is in Error

| Message                                         | Meaning                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Sandbox resource disappeared from the cluster` | Something outside Orchard deleted it. Starting it recreates it; if its disk went too, it starts empty. |
| `The Vercel sandbox no longer exists`           | Same, on Vercel.                                                                                       |
| `The Vercel sandbox failed`                     | Vercel reported the sandbox as failed. Start it again.                                                 |
| `Failed to create sandbox: ...`                 | Creation was refused; the rest of the message says why.                                                |

## SSH says the host key changed

Machines keep their host keys on their own disk, so stopping and starting never
changes them. Deleting a machine and creating a new one with the same name does.

With `orchard sandbox ssh-config --install` this is handled for you: every
connection fetches the machine's current host keys from Orchard and updates
`~/.orchard/ssh/known_hosts` before SSH checks it. If you still see the warning,
the stale key is in a `known_hosts` file Orchard does not manage, for example from
a host block you wrote by hand. Run the installer and remove the stale entry:

```bash
orchard sandbox ssh-config --install
ssh-keygen -R orchard-<name>
```

`Permission denied (publickey)` means none of your SSH identities matches the key
your client offered. `--install` registers its own key; otherwise add your key
under **User settings → Sandbox**.

## Link GitHub to push

The pull request button reads **Link GitHub to push**, or an action fails with
`github_not_linked`, when you have no GitHub account linked to Orchard. Pushes,
pull requests and merges use your own account, so each person on a machine needs
their own link. Link it under **User settings → GitHub and Tailscale** and try
again. Committing works without it.

`No GitHub account is linked to read checks` on the **Checks** tab means neither
you nor the host has linked GitHub. Checks are read with your GitHub access, or
the host's when you have none.

## Sessions

| Error                                               | Fix                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `"<repo>" is not a git repository in this sandbox`  | The repository is not cloned yet, or the clone failed. Check `~/.clone.log`. |
| `Could not find the base branch in that repository` | The base branch does not exist on `origin` or locally. Pick another one.     |
| `This session is archived`                          | Restore it first (`orchard sandbox session archive --restore`).              |
| `Sandbox is not running`                            | Start the machine.                                                           |

## Terminals

- `The sandbox is still setting up. Try again in a moment.` The `dev` user does not
  exist yet because the machine is still booting.
- `Interactive shells are not available for Vercel sandboxes` The installed Vercel
  SDK cannot open shells; your operator needs to upgrade it.
- A terminal that says it is waiting to start is attached to a script or a shell
  that has not started yet; it connects as soon as it does.

## Previews

| Message                                             | Meaning                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Previews need a preview domain`                    | Your operator has not set a preview domain, so Kubernetes previews are off.  |
| `That port cannot be previewed`                     | Use one of 3000, 3001, 4173, 5173, 8000, 8080 or 8787.                       |
| `This preview link has expired or was already used` | Preview links are single use for 60 seconds. Open it again from Greenhouse.  |
| `Nothing is answering on this port in the sandbox`  | Nothing listens there, or it listens on `localhost` only. Bind to `0.0.0.0`. |
| `Cross-site requests to previews are not allowed`   | Another site tried to call your preview. Open it directly.                   |
| `You no longer have access to this sandbox`         | You were removed from the machine.                                           |

## Forking

| Error                                                                               | Meaning                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `This cluster has no VolumeSnapshotClass for the sandbox disk's storage class, ...` | The cluster's storage cannot snapshot, so Kubernetes forks are off. |
| `This machine has no home volume to copy yet`                                       | Start the machine once before forking it.                           |
| `Only the machine's owner can fork it`                                              | Forks copy the host's home directory and credentials.               |
| `Sandbox limit reached`                                                             | A fork is a new machine and counts against your limit.              |
