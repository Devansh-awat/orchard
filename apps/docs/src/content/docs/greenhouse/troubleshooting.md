---
title: Troubleshooting Greenhouse
description: Fix common Greenhouse failures by symptom, including machines that do not start, failed changes, runner errors, SSH host keys, GitHub linking, and previews.
sidebar:
  order: 13
---

Use this page to fix common failures with Greenhouse. Each entry lists the symptom, the cause, and the fix.

## Greenhouse is not in the sidebar

**Cause:** The `greenhouse` graft is not installed on this instance. `/sandboxes` shows a not found page.

**Fix:** Ask an operator to install the graft. Refer to [Run Greenhouse](/operate/greenhouse/#install-the-graft). **Instance admin** > **Grafts** shows whether the graft loaded, and the reason if it failed.

## Sandbox feature is not enabled for your account

```text
Sandbox feature is not enabled for your account
```

**Cause:** The instance has PostHog configured, and your account does not have the `greenhouse` feature flag. Greenhouse is also missing from the sidebar in this case.

**Fix:** Ask an operator to enable the flag for your account.

## The machine takes a long time to start

**Cause:** On an image without the required tools, the first boot installs them. Later starts skip what is installed. The workspace shows the current step:

| Step                         | What happens                                       |
| ---------------------------- | -------------------------------------------------- |
| Starting the machine         | The runner brings the machine up.                  |
| Installing packages          | Installs `sshd`, `git`, and `tmux`, if missing.    |
| Installing the runtime       | Installs Node.js, if missing.                      |
| Installing coding agents     | Installs the agents, if missing.                   |
| Preparing storage            | Formats the home disk on first boot, and mounts it. |
| Setting up your account      | Creates the `dev` user, SSH host keys, and SSH configuration. |
| Starting services            | Starts SSH and the agent server.                   |

**Fix:** Wait for the steps to finish. If the machine does not start, refer to the next entry.

These logs are on the machine. Read them from a terminal or over SSH.

| File                          | Contents                                          |
| ----------------------------- | ------------------------------------------------- |
| `~/.setup.log`                | The machine setup script                          |
| `~/.clone.log`                | The repository named at creation                  |
| `~/.opencode-serve.log`       | The agent server                                  |
| `/var/log/orchard-bridge.log` | The SSH bridge, on Vercel machines                |

## Sandbox did not become ready in time

```text
Sandbox did not become ready in time
Sandbox resource never appeared in the cluster
```

**Cause:** The machine stayed in **Creating** or **Starting** for 10 minutes, or 30 minutes for a fork. The second message means the runner did not create the resource.

**Fix:** Start the machine again. If it fails the same way, contact your operator.

## A machine shows Apply failed

**Cause:** Orchard carries out starts, stops, deletes, and credential syncs through a queue. A worker retries a failed change up to ten times, with increasing delays. Transient errors clear without action. After the last attempt, the error stays on the machine.

**Fix:** Fix the cause, then queue the failed changes again. The host or an organization admin can select **Retry** in the machine menu, or run the following command:

```bash
orchard sandbox retry my-machine
```

If the error returns, or the machine shows **Applying** for more than a few minutes, contact your operator.

## A runner is not available

The API returns one of these messages when you create a machine on an unavailable runner:

| Message                                                                                     | Cause                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Kubernetes sandboxes are turned off on this server`                                        | The operator turned the runner off.                         |
| `Vercel sandboxes are turned off on this server`                                            | The operator turned the runner off.                         |
| `Kubernetes is not configured on this server`                                               | The server has no cluster access.                           |
| `Vercel sandboxes need vercelToken (SANDBOX_VERCEL_TOKEN), ...`                             | Vercel credentials are incomplete. The message names what is missing. |
| `Vercel sandboxes need SECRETS_ENCRYPTION_KEY so their public ports are password protected` | The instance has no encryption key.                          |
| `No sandbox runner is available`                                                            | Every runner is off or misconfigured.                        |

**Fix:** Contact your operator. Machines already on a runner that is turned off keep working.

The **New machine** sheet offers only available runners.

## The machine stopped without a request

| Message                               | Cause                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| None                                  | Idle stop. There was no terminal or SSH activity for the idle limit, and no agent was working. |
| `Stopped after reaching max lifetime` | The machine reached the maximum time since its last start.                        |
| `Stopped by provider timeout`         | Vercel's timeout stopped the machine.                                            |

**Fix:** Start the machine again. Files on disk remain. Running processes, including dev servers and agent turns in progress, do not.

## The machine is in Error

| Message                                         | Cause and fix                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Sandbox resource disappeared from the cluster` | Something outside Orchard deleted the resource. Start the machine to recreate it. If its disk is also gone, it starts empty. |
| `The Vercel sandbox no longer exists`           | The sandbox is gone on Vercel. Start the machine to recreate it.                                    |
| `The Vercel sandbox failed`                     | Vercel reported a failure. Start the machine again.                                                 |
| `Failed to create sandbox: ...`                 | Creation failed. The rest of the message states why.                                                |

## SSH reports that the host key changed

**Cause:** Host keys stay the same across stops and starts. Deleting a machine and creating another with the same name changes them. The stale key is in a `known_hosts` file that Orchard does not manage.

**Fix:** Run the installer and remove the stale entry:

```bash
orchard sandbox ssh-config --install
ssh-keygen -R orchard-<name>
```

## Permission denied (publickey)

```text
Permission denied (publickey)
```

**Cause:** None of your SSH identities matches the key your client offered.

**Fix:** Run `orchard sandbox ssh-config --install`, or add your key in **Account settings** > **Greenhouse** > **SSH identities**.

## Link GitHub to push

The pull request button reads **Link GitHub to push**, or an action fails with `github_not_linked`.

**Cause:** Your account has no linked GitHub account. Pushes, pull requests, and merges use your own account.

**Fix:** Link it in **Account settings** > **GitHub and Tailscale**. You can commit without it.

## No GitHub account is linked to read checks

```text
No GitHub account is linked to read checks
```

**Cause:** Neither you nor the host has linked GitHub.

**Fix:** Link it in **Account settings** > **GitHub and Tailscale**.

## A session does not start

| Message                                             | Fix                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `"<repo>" is not a git repository in this sandbox`  | The repository is not cloned yet, or the clone failed. Check `~/.clone.log`. |
| `Could not find the base branch in that repository` | Select another base branch.                                                  |
| `This session is archived`                          | Restore it with `orchard sandbox session archive --restore`.                 |
| `Sandbox is not running`                            | Start the machine.                                                           |

## A terminal does not open

| Message                                                    | Cause and fix                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `The sandbox is still setting up. Try again in a moment.`  | The `dev` user does not exist yet. Wait for the machine to finish booting.               |
| `Interactive shells are not available for Vercel sandboxes` | The installed Vercel SDK cannot open shells. Your operator must upgrade it.             |

## Previews do not open

| Message                                             | Cause and fix                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Previews need a preview domain; ...`               | Your operator has not set a preview domain, so Kubernetes previews are off.       |
| `That port cannot be previewed`                     | Use 3000, 3001, 4173, 5173, 8000, 8080, or 8787, or declare the port in `.orchard/greenhouse.json`. |
| `This preview link has expired or was already used` | Links are single use and last 60 seconds. Open the preview again from Greenhouse. |
| `Nothing is answering on this port in the sandbox`  | Nothing listens on the port, or it listens on `localhost` only. Bind to `0.0.0.0`. |
| `Cross-site requests to previews are not allowed`   | Another site called your preview. Open the preview directly.                      |
| `You no longer have access to this sandbox`         | You were removed from the machine.                                                |

## A fork fails

| Message                                                                             | Cause and fix                                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `This cluster has no VolumeSnapshotClass for the sandbox disk's storage class, ...` | The cluster cannot snapshot the storage, so Kubernetes forks are off. |
| `This machine has no home volume to copy yet`                                       | Start the machine once before forking it.                         |
| `Only the machine's owner can fork it: ...`                                         | The copy contains the host's home directory and credentials.      |
| `Forking needs Vercel drive forks, which this team's plan doesn't have`             | The operator's Vercel plan does not include drive forks.          |
| `Sandbox limit reached (...)`                                                       | A fork counts against your machine limit. Ask a superadmin to raise it. |

## Still stuck?

Collect the machine's name, runner, status message, and the relevant log above. Then contact your instance operator.
