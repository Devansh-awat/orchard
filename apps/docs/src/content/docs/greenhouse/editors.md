---
title: Open in your editor
description: Connect VS Code, Cursor, Zed or plain ssh to a machine through Orchard's tunnel.
sidebar:
  order: 5
---

Any machine you host can be opened in a desktop editor over SSH. Nothing is
exposed to the internet for this: your SSH client runs `orchard sandbox proxy`
as its `ProxyCommand`, which carries the connection over an authenticated
websocket to the Orchard server and on to the machine.

SSH and editor links are for the **host** only. The SSH user is `dev`, and the
machine holds the host's credentials, so the server refuses the tunnel to anyone
else (superadmins excepted).

## One-time setup

Install the [Orchard CLI](/cli/), sign in, then run:

```bash
orchard sandbox ssh-config --install
```

It does four things, and is safe to run again:

1. Generates a key at `~/.orchard/ssh/id_ed25519` (kept if it already exists).
2. Registers its public key as an [SSH identity](/account/ssh-identities/) on
   your account, named after your computer. Every machine you host trusts every
   identity on your account, so this key works everywhere.
3. Writes `~/.orchard/ssh/config` with one wildcard block for all your machines:

   ```
   Host orchard-*
     User dev
     IdentityFile ~/.orchard/ssh/id_ed25519
     IdentitiesOnly yes
     ProxyCommand "/path/to/orchard" sandbox proxy --host %n
     StrictHostKeyChecking accept-new
     UserKnownHostsFile ~/.orchard/ssh/known_hosts
     ServerAliveInterval 30
   ```

4. Adds `Include ~/.orchard/ssh/config` to the top of `~/.ssh/config`.

After that, every machine is reachable as `orchard-<name>`:

```bash
ssh orchard-leafy
scp ./notes.md orchard-leafy:~/
```

Agent forwarding, port forwarding (`-L`, `-R`), `rsync` and `scp` all work, since
it is ordinary SSH end to end. The workspace shows a short setup popover under
**Open in** until this is done.

## Open in VS Code, Cursor or Zed

**Open in** in the workspace's top bar opens the current session's worktree
directly. The button remembers the editor you used last; its menu has the others
and a copy of the plain `ssh` command.

| Editor  | Link it opens                                                 | Needs                      |
| ------- | ------------------------------------------------------------- | -------------------------- |
| VS Code | `vscode://vscode-remote/ssh-remote+orchard-<name>/<worktree>` | the Remote - SSH extension |
| Cursor  | `cursor://vscode-remote/ssh-remote+orchard-<name>/<worktree>` | nothing extra              |
| Zed     | `zed://ssh/orchard-<name>/<worktree>`                         | nothing extra              |

`<worktree>` is the session's directory, for example
`/persist/home/.worktrees/app/fix-login-a1b2c3`. You land in the same files the
agent is editing, on the session's branch.

These links rely on the `orchard-*` host block above, so run
`ssh-config --install` on each computer you open machines from.

## Host keys

Each machine generates its SSH host keys on first boot and keeps them on its disk
(`/persist/hostkeys`), so they survive stops and starts.

Orchard keeps your `~/.orchard/ssh/known_hosts` in step with them. Every time the
proxy connects (and every time `orchard sandbox ssh` runs) it fetches the
machine's current public host keys from the API and rewrites that host's entry
before SSH checks it. A machine you deleted and recreated under the same name
therefore connects without a **host key changed** warning: the new keys come
from Orchard over your authenticated session, not from the network on first use.

The keys are only rewritten in Orchard's own `known_hosts` file, never in
`~/.ssh/known_hosts`.

## Without installing anything

`orchard sandbox ssh` opens a shell without touching your SSH config. It starts a
stopped machine first with `--start`, and passes anything after `--` to `ssh`:

```bash
orchard sandbox ssh leafy --start
orchard sandbox ssh leafy -- -L 3000:localhost:3000
```

`orchard sandbox ssh-config [name]` prints a `Host` block per machine for
pasting into a config by hand.

## Requirements

- The machine is running.
- You are its host.
- At least one SSH identity on your account. `ssh-config --install` creates one;
  you can also add or import keys under **User settings → Sandbox** or with
  `orchard ssh-identity`.
- If the CLI authenticates with an API token, the token has the `exec` scope
  (`orchard auth token create --scope exec`).

On a Vercel machine the connection travels one hop further, through a small
bridge inside the machine that only accepts the machine's own secret. It behaves
the same from your side.
