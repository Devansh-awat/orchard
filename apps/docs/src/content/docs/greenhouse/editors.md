---
title: Connect an editor over SSH
description: Connect VS Code, Cursor, Zed, or ssh to a Greenhouse machine through the Orchard CLI. Only the host of a machine can connect over SSH.
sidebar:
  order: 5
---

To open a Greenhouse session in a desktop editor, connect over SSH. The connection goes through the Orchard server, so the machine does not need to accept connections from the internet.

Your SSH client runs `orchard sandbox proxy` as its `ProxyCommand`. That command carries the connection over an authenticated WebSocket to the Orchard server, and from there to the machine.

## Prerequisites

- Host access to the machine. The server refuses this connection for guests, because the machine holds the host's credentials. Superadmins can also connect.
- A running machine.
- The [Orchard CLI](/cli/), installed and signed in.
- If the CLI authenticates with an [API token](/account/tokens/), the `exec` scope on that token. To create one, run `orchard auth token create --scope exec`.

## 1. Configure SSH

Run the following command on each computer that you connect from:

```bash
orchard sandbox ssh-config --install
```

The command makes these changes. You can run it more than once.

1. It generates a key at `~/.orchard/ssh/id_ed25519`, unless one exists.
2. It registers the public key as an [SSH identity](/account/ssh-identities/) on your account. Every machine you host trusts all of your identities.
3. It writes `~/.orchard/ssh/config` with one block for all of your machines:

   ```text
   Host orchard-*
     User dev
     IdentityFile ~/.orchard/ssh/id_ed25519
     IdentitiesOnly yes
     ProxyCommand "/path/to/orchard" sandbox proxy --host '%n'
     StrictHostKeyChecking accept-new
     UserKnownHostsFile ~/.orchard/ssh/known_hosts
     ServerAliveInterval 30
   ```

4. It adds `Include ~/.orchard/ssh/config` to `~/.ssh/config`.

## 2. Connect

To open the current session in an editor:

1. In the workspace title bar, select the editor button. It shows the editor you used last.
2. To choose another editor, open the menu next to the button.
3. Select **VS Code**, **Cursor**, or **Zed**. The **Terminal** item gives you the `ssh` command to copy.

The editor opens the session's worktree, for example `/persist/home/.worktrees/app/fix-login-a1b2c3`. VS Code requires the Remote - SSH extension.

| Editor  | Link                                                          |
| ------- | ------------------------------------------------------------- |
| VS Code | `vscode://vscode-remote/ssh-remote+orchard-<name>/<worktree>` |
| Cursor  | `cursor://vscode-remote/ssh-remote+orchard-<name>/<worktree>` |
| Zed     | `zed://ssh/orchard-<name>/<worktree>`                         |

To connect from a terminal, use the machine's name:

```bash
ssh orchard-my-machine
scp ./notes.md orchard-my-machine:~/
```

The connection is ordinary SSH. Port forwarding, agent forwarding, `rsync`, and `scp` work.

## Connect without changing your SSH config

`orchard sandbox ssh` opens a shell without the setup above. Add `--start` to start a stopped machine first. Arguments after `--` go to `ssh`.

```bash
orchard sandbox ssh my-machine --start
orchard sandbox ssh my-machine -- -L 3000:localhost:3000
```

To print a `Host` block for a machine and paste it into a config by hand, run `orchard sandbox ssh-config my-machine`.

## Host keys

Each machine generates SSH host keys on first boot and stores them in `/persist/hostkeys`. A stop or start does not change them.

When the proxy connects, the CLI fetches the machine's current host keys from Orchard and updates `~/.orchard/ssh/known_hosts`. This covers a machine that you deleted and recreated under the same name. The CLI does not change `~/.ssh/known_hosts`.

## Related resources

- [Manage SSH identities](/account/ssh-identities/)
- [Troubleshooting Greenhouse](/greenhouse/troubleshooting/#ssh-reports-that-the-host-key-changed)
- [Workspace](/greenhouse/workspace/)
- [Machines](/greenhouse/machines/)
