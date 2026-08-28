# Greenhouse: AI sandboxes

Conductor-style cloud dev sandboxes built into Orchard. Each sandbox is an
isolated VM-backed environment where a coding agent (Claude Code, Codex) can
run with full internet access and zero blast radius: no cluster access, no
access to other users, nothing to leak but its own workspace.

Feature-flagged and off by default (`sandbox.enabled` in the Helm chart).
Routes, CLI, and API stay neutral (`/sandboxes`, `orchard sandbox`);
"Greenhouse" is the product name in the UI.

## Motivation

Running a coding agent on your own machine means the agent runs with your
credentials, your SSH keys, your dotfiles, and your network position. The
usual mitigation is to babysit it. A sandbox flips that: give the agent a
disposable machine where the worst case is bounded by construction, and let
it work unattended. Parallel agents get parallel sandboxes.

Orchard already has the hard parts: a cluster, Kata Containers for VM
isolation (the image builders use it), per-namespace network policy, an
auth/token model with scopes, and a CLI. Greenhouse composes them into a
personal dev VM you can SSH into, point VS Code at, or hand to an agent.

## Architecture

One sandbox = one Sandbox custom resource in the `orchard-sandboxes`
namespace, orchestrated by the
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
controller (`agents.x-k8s.io/v1beta1`, pinned release). The CR wraps:

- a single-container pod from `infra/images/sandbox` (Ubuntu 24.04, sshd,
  node 22, pnpm, Claude Code, Codex, passwordless-sudo user `dev`), running
  under the `kata` RuntimeClass so the pod is a lightweight VM
- a persistent home volume. In block mode the PVC attaches as a raw block
  device (`/dev/sandboxhome`) and the entrypoint formats and mounts it
  in-guest; ext4 over virtio-blk is near-native speed, avoiding the
  virtio-fs tax on npm/pnpm-heavy work. Filesystem mode (dev clusters
  without kata) mounts a regular PVC instead
- a per-sandbox Secret carrying `authorized_keys`, the user's GitHub token,
  and optional agent tokens

The controller owns pod-level reconciliation: stop/start is a patch of
`spec.operatingMode` (`Suspended` deletes the pod, keeps the PVC and
identity; `Running` brings it back), and status conditions map onto the
sandbox states the API exposes. All CR interaction lives in one server file
(`sandbox-k8s.service.ts`) so a fallback to direct pod management is a
one-file change if the beta API churns.

There is no ingress. Sandboxes are reachable only through the server, which
tunnels SSH over an authenticated websocket:

```
ssh dev@orchard-sandbox-<name>
  └── ProxyCommand: orchard sandbox proxy <name>
        └── wss://<orchard>/apiv1/sandboxes/<id>/ssh   (exec-scoped token)
              └── orchard-server (in-cluster)
                    └── TCP :22 to the sandbox pod IP
                          └── sshd inside the kata VM
```

Binary websocket frames carry raw TCP bytes in both directions. Anything
that speaks SSH ProxyCommand works unchanged: plain `ssh`, `scp`, `rsync`,
VS Code Remote-SSH.

## Agent integration

Claude Code and Codex are preinstalled in the image. Two auth paths:

- **Subscription tokens.** `orchard sandbox credentials set --claude -`
  (or the Greenhouse UI) stores a long-lived Claude Code OAuth token (from
  `claude setup-token`) and/or an OpenAI key, encrypted at rest. They are
  decrypted only into the per-sandbox Secret and surface as
  `CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY` inside the sandbox, so
  `claude` and `codex` work headlessly on first SSH.
- **Interactive login.** `claude login` inside the sandbox always works and
  persists on the home volume across stop/start.

The idle reaper is busy-aware: before suspending an idle sandbox it checks
for a running `claude`/`codex` process and skips suspension if one is found.
Long agent jobs survive with zero SSH connections open; the cap is the max
lifetime, not the SSH session.

The user's GitHub token is injected as a git credential helper, so `git
clone`/`push` against their repos works without setup. An optional
`repoUrl` at create time is cloned in the background on first boot
(`~/.clone.log` has the outcome; a failed clone never kills the sandbox).

## Security model

- **Isolation boundary: the kata VM.** The container is privileged inside
  the VM (it formats and mounts its own block device), which is the same
  justification as the image builders: privileged-in-VM, not
  privileged-on-host. On clusters without kata the chart's filesystem mode
  drops the privilege requirement along with the block-device fast path.
- **Network containment: the namespace NetworkPolicy.** Ingress only from
  orchard server pods on TCP 22. Egress only to kube-dns and the public
  internet, with RFC1918, link-local, and carrier-grade NAT ranges
  excluded. No sandbox-to-sandbox traffic, no cluster services, no IMDS.
- **No service account.** Sandbox pods run with
  `automountServiceAccountToken: false` and no bound role.
- **SSH access.** Key-only auth, user `dev` only, no passwords, no root
  login. Keys are per-sandbox and rotate live (the Secret propagates and
  sshd re-reads authorized keys per attempt). The websocket tunnel requires
  the `exec` token scope, same as pod exec.
- **Feature gating and limits.** Everything 404s unless `SANDBOX_ENABLED`
  is set. Per-user cap (default 1, admin-adjustable per user), idle timeout,
  and max lifetime bound resource usage.
- **Agent tokens.** Encrypted at rest with the existing secret crypto
  (AES-256-GCM, fails closed without `SECRETS_ENCRYPTION_KEY`); never
  returned by the API (presence booleans only); decrypted only into a
  Secret that lands in a VM the owning user fully controls.

## API

All routes are user-scoped: you see and touch only your own sandboxes
(superadmins excepted). Disabled feature or foreign sandbox both read as
404.

| Route | Scope | Notes |
| --- | --- | --- |
| `POST /sandboxes` | deploy | create; optional name, repoUrl, sshIdentityId, setupScript |
| `GET /sandboxes` | read | returns `{ sandboxes, maxSandboxes }` |
| `GET /sandboxes/:id` | read | |
| `PATCH /sandboxes/:id` | deploy | rename, switch SSH identity, edit setup script |
| `POST /sandboxes/:id/start` | deploy | resume a suspended sandbox |
| `POST /sandboxes/:id/stop` | deploy | suspend; home volume persists |
| `DELETE /sandboxes/:id` | deploy | removes CR, secret, and volumes |
| `GET /sandboxes/:id/ssh` | exec | websocket upgrade; raw SSH bytes |
| `POST /sandboxes/:id/chat` | exec | Cloud Code: SSE stream of the in-sandbox claude agent |
| `GET /sandboxes/:id/changes` | exec | git status and diffstat, scoped with `?repo=` |
| `GET /sandboxes/:id/diff` | exec | git diff, whole tree or one file via `?file=`, scoped with `?repo=` |
| `GET /sandboxes/:id/repos` | exec | list git repositories cloned into the sandbox |
| `POST /sandboxes/:id/repos` | deploy | clone another repository into the sandbox |

A sandbox is a computer, not a repo checkout: clone as many repositories into it as you like (each lands in `/persist/home/<name>` on the persistent volume) and point the agent's working directory at any of them per message.
| `GET /sandboxes/credentials` | read | `{ claude: boolean, openai: boolean }` |
| `PUT /sandboxes/credentials` | deploy | set or clear agent tokens (null clears) |
| `GET /ssh-identities` | read | named public keys attached to your user |
| `POST /ssh-identities` | deploy | add an identity `{ name, publicKey }` |
| `POST /ssh-identities/import-github` | deploy | import your GitHub public keys |
| `DELETE /ssh-identities/:id` | deploy | fails while attached to a sandbox |

SSH identities and agent credentials are user-level resources managed from user settings. A sandbox attaches one identity by reference; rotating the identity updates the sandbox's authorized_keys live. Cloud Code chat runs `claude` inside the sandbox as the dev user, streams stream-json events over SSE, and resumes the same claude session across messages (the session lives on the sandbox's persistent home volume).

## CLI walkthrough

```console
$ orchard sandbox create leafy --repo https://github.com/hackclub/orchard --wait
$ orchard sandbox list
NAME    STATUS    REPO              CREATED        LAST ACTIVE
leafy   running   hackclub/orchard  2 minutes ago  just now
1 of 1 sandboxes used
$ orchard sandbox ssh leafy
dev@sbx-…:~$ cd orchard && claude
```

`create` auto-loads `~/.ssh/id_ed25519.pub` (then `id_rsa.pub`) when no
`--key` is given, and `--github-keys` imports your public keys from GitHub.
`ssh` starts a stopped sandbox on demand (`--start`, or a prompt in a TTY)
and then execs your local `ssh` with a ProxyCommand pointed at the tunnel,
so agent forwarding, `-L`/`-R`, and `scp` all behave normally.

For VS Code Remote-SSH (or a plain `~/.ssh/config` entry):

```console
$ orchard sandbox ssh-config leafy >> ~/.ssh/config
```

then connect to `orchard-sandbox-leafy` from the Remote-SSH picker. The
host block uses the same ProxyCommand, so no ports are exposed anywhere.

Agent tokens, without leaving tokens in shell history:

```console
$ claude setup-token | pbcopy
$ pbpaste | orchard sandbox credentials set --claude -
$ orchard sandbox credentials status
claude: configured
openai: not set
```

Lifecycle: `orchard sandbox stop|start --wait`, `orchard sandbox delete`.
Note that delete-and-recreate produces a new host key (stop/start does
not); the generated ssh config uses `accept-new` so this is a prompt, not
an error.

## End goal: leafy bot

The long-term reason Greenhouse exists: a Slack agent that lives in a
sandbox. "leafy" is a bot user backed by a persistent sandbox running
Claude Code with repo access, driven by Slack events. The sandbox model is
what makes this safe to leave running: the agent has a full dev machine and
nothing else.

Three concrete flows:

1. **Feature request.** Seb pings `@leafy build X` in a channel. Leafy
   spins up (or reuses) its sandbox, branches the target repo, implements,
   pushes, opens a PR, and replies in-thread with the PR link and a
   summary. Iteration happens in the thread; leafy amends the branch.
2. **Bug triage.** A stack trace or error report is posted at leafy. It
   reproduces in the sandbox, replies with a diagnosis, and follows up
   with a fix PR when the fix is mechanical.
3. **Self-update.** Leafy PRs Orchard's own repo. The normal pipeline
   (review, merge, release, deploy) ships the change; leafy never deploys
   itself directly. Orchard building Orchard, with a human merge gate.

What exists today: the sandbox substrate (this document), headless agent
auth, busy-aware reaping so long jobs run unattended, and repo access via
the injected GitHub credential.

Missing pieces, in rough order:

- Slack app with event subscriptions (mentions, threads, DMs) and a
  bot-token store
- an agent runner loop inside the sandbox: consume a task, drive Claude
  Code non-interactively, stream progress back
- GitHub App credentials for PR automation as the bot identity (not a
  user's personal token)
- deploy/approval hooks so a human gate sits between PR and production
- secret injection story for tasks that need environment values
- conversation-to-sandbox mapping (one long-lived sandbox vs per-thread
  sandboxes, and how context carries across tasks)

## Roadmap

Now (v1, this iteration):

- Sandbox CRUD + lifecycle via agent-sandbox CRs, kata isolation,
  block-device home volumes
- SSH websocket tunnel, CLI (`orchard sandbox …`), VS Code Remote-SSH
- Greenhouse UI page, usage tab, admin per-user limits
- Agent credentials (Claude Code, Codex) with encrypted storage
- Busy-aware idle reaper + max lifetime

Later:

- SandboxTemplate/WarmPool for instant allocation (the agent-sandbox
  feature that motivated adopting it)
- user-scoped SSE for live status instead of polling
- leafy bot (previous section)
- snapshots/forking of sandbox homes, team-shared sandbox images
