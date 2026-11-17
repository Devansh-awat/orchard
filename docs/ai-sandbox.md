# Greenhouse: architecture

Greenhouse is Orchard's multiplayer AI development environment. A **machine**
(a sandbox) is an isolated Linux box with a persistent home, running an opencode
agent server. A **session** is a git worktree on its own branch with an agent
chat in it. Several people can share a machine as host and guests, and see each
other's prompts, drafts, cursors and terminals live.

The product name is Greenhouse. Routes, the CLI, MCP tools, tables and code stay
neutral: `/sandboxes`, `orchard sandbox`, `list_sandboxes`, `sandboxes`,
`grafts/greenhouse/server/src/sandboxes`.

User docs: `apps/docs/src/content/docs/greenhouse/`. Operator docs:
`apps/docs/src/content/docs/operate/greenhouse.md`. This file is the design.

## Code map

| Area                                | Where                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Runner interface, registry          | `sandboxes/runners/sandbox-runner.ts`, `sandbox-runner.registry.ts`                                      |
| Kubernetes runner                   | `sandboxes/runners/kubernetes.runner.ts`, `sandboxes/sandbox-cr.ts`                                      |
| Vercel runner                       | `sandboxes/runners/vercel.runner.ts`                                                                     |
| Desired to observed status          | `sandboxes/runners/sandbox-status.ts`                                                                    |
| Secrets, init files                 | `sandboxes/runners/sandbox-secrets.ts`, `sandbox-init-files.ts`                                          |
| Bootstrap script                    | `sandboxes/sandbox-bootstrap.ts`                                                                         |
| Machine lifecycle and API           | `sandboxes/sandboxes.service.ts`, `sandboxes.controller.ts`                                              |
| Access model                        | `sandboxes/sandbox-access.service.ts`, `sandbox-role-gate.ts`, `sandbox-opencode-policy.ts`              |
| Sessions, scripts, ports            | `sandboxes/sandbox-sessions.service.ts`, `sandbox-session-commands.ts`                                   |
| Workspace (files, git, agent proxy) | `sandboxes/sandbox-workspace.service.ts`                                                                 |
| Git identity per person             | `sandboxes/sandbox-git-identity.ts`                                                                      |
| Terminals                           | `sandboxes/sandbox-terminal.gateway.ts`, `kubernetes/exec-session-engine.ts`                             |
| SSH tunnel                          | `sandboxes/sandbox-ssh.gateway.ts`, `sandbox-connect.service.ts`                                         |
| Live gateway, Yjs                   | `sandboxes/live/*`                                                                                       |
| Previews                            | `sandboxes/preview/*`                                                                                    |
| Members, comments, prompts          | `sandboxes/sandbox-members.*`, `sandbox-agent.*`                                                         |
| Attention notifications             | `sandboxes/sandbox-attention.service.ts`                                                                 |
| Project links, preview deploys      | `sandboxes/links/*`                                                                                      |
| Forks, share links                  | `sandboxes/sandbox-fork.*`, `sandbox-share-links.*`                                                      |
| Integrations                        | `sandboxes/integrations/*`                                                                               |
| Reaper                              | `sandboxes/sandbox-reaper.service.ts`                                                                    |
| Mirror consumer                     | `mirror/consumers/sandbox-mirror.consumer.ts`, shard in `mirror/mirror-shards.ts`                        |
| MCP tools                           | `mcp/tools/sandboxes.ts`                                                                                 |
| CLI                                 | `apps/cli/cmd/sandbox*.go`, `internal/sshproxy`                                                          |
| Frontend                            | `grafts/greenhouse/ui/src/components/greenhouse`, `components/sandbox/{chat,editor}`, `routes/sandboxes` |

All paths above are under `apps/server/src` unless they say otherwise.

## Runners

A runner is where machines run. Two ship: `kubernetes` (the agent-sandbox
controller on the instance's cluster) and `vercel` (`@vercel/sandbox`). Each
machine row records its runner (`Sandbox.runner`) and keeps it for life.

### Interface

`SandboxRunner` in `runners/sandbox-runner.ts`:

| Group        | Members                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Identity     | `id`, `label`, `capabilities`, `namespace?`, `configError()`, `defaultImage?()`                                               |
| Lifecycle    | `requestProvision`, `requestStart`, `requestStop`, `requestDestroy`, `requestSecretSync`. These only **enqueue** apply items. |
| Observation  | `observe(ref)`, `observeDisks?(refs)`, `canTrustAbsence()`, `reconcile?(refs)`, `keepAlive?(ref)`                             |
| Exec, files  | `exec(ref, argv, {stdin, env, timeoutMs})`, `execStream`, `writeFiles`, `readFile(path, {maxBytes, fromEnd, asUser})`         |
| Connectivity | `openPty(ref, {command, cols, rows})`, `httpTarget(ref, port)`, `openTcp(ref, port)`                                          |
| Forking      | `forkSupport?(source)`, `requestFork?(source, target)`                                                                        |

Execs run as root; callers wrap with `su -l dev -c` where they want the `dev`
user. File writes go through stdin, never argv, so size is not bounded by
`MAX_ARG_STRLEN`. Calling into a machine that is not running throws
`SandboxNotRunningError` (a 400).

`SandboxRef` is `{id, userId, runner, podName, namespace, externalId,
runnerState}`. `podName` is `sbx-<uuid>` on both runners, generated before the
row is inserted, and is the resource name on Kubernetes and the sandbox name on
Vercel. `runnerState` is runner-private JSON (secret hash, cached host keys, fork
markers, Vercel `expiresAt` and `bridgeUrl`).

### Capabilities

|                        | kubernetes                                                                              | vercel                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `statusSource`         | `watch` (mirror)                                                                        | `poll`                                                   |
| `persistence`          | `volume`                                                                                | `snapshot`                                               |
| `homeMode`             | `block` or `filesystem`                                                                 | `none` (`/persist` links into `/vercel/sandbox/orchard`) |
| `tcpTunnel`            | `native` (pod IP or port-forward)                                                       | `bridge` (websocket on 2222)                             |
| `pty`                  | `native` (k8s exec, tty)                                                                | `native` when the SDK has `openInteractive`, else `none` |
| `execStdin`            | yes                                                                                     | yes (staged through a temp file)                         |
| `diskSizeConfigurable` | yes                                                                                     | no                                                       |
| `fork`                 | when a VolumeSnapshotClass matches the storage class (probed every 5 minutes)           | yes                                                      |
| `previews`             | `proxy` when a usable `previewDomain` is configured (server preview proxy), else `none` | `public`                                                 |

### Registry

`SandboxRunnerRegistry`:

- `for(row)` returns the row's runner and **never** checks whether it is enabled,
  so disabling a runner never strands existing machines.
- `resolveForCreate(requested?)` enforces enabled and configured, falling back to
  the configured default, then the first available runner.
- `describe()` returns `{runners: [{id, label, capabilities, available, reason}],
defaultRunner}` for `GET /sandboxes` and the new machine sheet.

Enablement comes from the `sandbox-runners` instance-config section
(`kubernetesEnabled` default true, `vercelEnabled` default false).

## Desired state, observed state, apply queue

Every mutation writes **desired state** on the `sandboxes` row
(`desiredState: running | stopped | deleted`) and a transitional `status`, then
enqueues apply items. Nothing calls the Kubernetes or Vercel API inline from a
request. Status converges from observations.

### Apply operations

The queue is `k8s_apply_queue` (`K8sApplyItem`), drained by
`apply/apply-queue.service.ts`. Items dedupe on `dedupeKey`, so a newer intent
replaces an older pending one. `K8sApplyItem.sandboxId` lets the API report
`applying` and `applyError` per machine (`SandboxesService.dtos`).

| opType                                                           | Dedupe key                    | Manifest                           | Handler                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssa`                                                            | `sandboxes:ns`                | Namespace                          | Server-side apply. Enqueued on leader acquire and with every provision.                                                                                                                                                                                             |
| `ssa`                                                            | `sandboxes:netpol`            | NetworkPolicy `sandbox-isolation`  | Server-side apply, same triggers.                                                                                                                                                                                                                                   |
| `sandbox.secret.sync`                                            | `sandbox:<id>:secret`         | `{sandboxId}`                      | Builds the Secret from encrypted credentials at apply time, creates or replaces `sbx-<id>-auth` with an `orchard.my/spec-hash` annotation, stores `runnerState.secretHash`, and when running pushes the attached-project env bundle in by exec.                     |
| `sandbox.cr.apply`                                               | `sandbox:<id>:cr`             | `{sandboxId}`                      | `stopped`: merge-patch `operatingMode: Suspended`. `running`: SSA the Sandbox CR, keeping existing `volumeClaimTemplates`. Applies the returned CR as an observation.                                                                                               |
| `sandbox.destroy`                                                | `sandbox:<id>:destroy`        | `{sandboxId, podName}`             | Refuses unless the row is `desiredState=deleted` (or there is no row: an orphan). Deletes the CR, Secret, labelled PVCs and fork VolumeSnapshot, then the row.                                                                                                      |
| `sandbox.fork.snapshot`                                          | `sandbox:<id>:fork`           | `{sandboxId, sourceSandboxId}`     | Creates a VolumeSnapshot of the source home PVC, records `runnerState.forkSnapshot`, enqueues the CR whose claim template restores from it.                                                                                                                         |
| `sandbox.fork.cleanup`                                           | `sandbox:<id>:fork-cleanup`   | `{sandboxId}`                      | Enqueued by the mirror when the fork's PVC is `Bound` or its CR is running (and on every list pass). Only acts when the row is `running` and the home PVC is `Bound`: deletes the fork VolumeSnapshot, then drops `forkSnapshot` and `forkFrom` from `runnerState`. |
| `ssa`                                                            | `sandbox:<id>:preview-netpol` | NetworkPolicy `sbx-<id>-previews`  | Ingress from server pods to the machine's declared preview ports (`runnerState.declaredPorts`), selected by `orchard.my/sandbox-id`. Deleted by `sandbox.destroy`.                                                                                                  |
| `vercel.provision`, `vercel.start`, `vercel.stop`, `vercel.fork` | `sandbox:<id>:vercel`         | `{sandboxId}` (+`sourceSandboxId`) | One converge function: stop, or resume (`Sandbox.get({resume:true})`), create or fork on 404, update the network policy, wait up to 90 s for `running`, push init files, run bootstrap, record `expiresAt` and `bridgeUrl`, mark `running`.                         |
| `vercel.secret.sync`                                             | `sandbox:<id>:vercel.secret`  | `{sandboxId}`                      | Updates the GitHub network policy; when running, pushes init files and reruns the idempotent bootstrap.                                                                                                                                                             |
| `vercel.destroy`                                                 | `sandbox:<id>:vercel.destroy` | `{sandboxId}`                      | Deletes the sandbox with `deleteOrphanSnapshots`, then the row.                                                                                                                                                                                                     |

Manifests never contain secrets. Vercel handlers are serialized per machine in
process. Failed items retry with exponential backoff from 5 s to 10 minutes, up
to 10 attempts. `ApplyQueueService.retryForSandbox` resets a machine's failed
items; `POST /sandboxes/:id/apply/retry` (owner or org admin, audited as
`sandbox.apply.retry`) and `orchard sandbox retry` call it.

The queue drains only where `LeaseService.canCoordinate` is true (a kubeconfig
plus a control namespace: in-cluster, or `ORCHARD_CONTROL_NAMESPACE`), and not at
all with `APPLY_WORKER_DISABLED=true`. A dev server against a production database
is enqueue-only. This holds for Vercel items too: one rule for the queue.

### Observation to status

`deriveObservedStatus(row, observation)` in `runners/sandbox-status.ts`, applied
by `applyObservation` with an optimistic `updateMany` guarded on the previous
`status` and `desiredState`:

- Rows being deleted are never touched.
- Absent: `creating`, `starting` and `error` rows wait; anything else becomes
  `error` (`Sandbox resource disappeared from the cluster`).
- Present with a status: `desiredState=running` turns an observed `stopped` into
  `starting`; `desiredState=stopped` turns an observed `running` into `stopping`.
- A present resource with no settled status (created, not ready) changes nothing.

Vercel maps its states with `vercelStatusChange`: `stopping` and `snapshotting`
mean `stopping`; `stopped` while desired `running` means the provider timed it
out, so the row becomes `stopped` with `desiredState=stopped` and
`Stopped by provider timeout`; `failed` and `aborted` become `error`.

## Kubernetes runner

### Resources

`Sandbox` CR (`agents.x-k8s.io/v1beta1`) `sbx-<id>` in `SANDBOX_NAMESPACE`
(default `orchard-sandboxes`), labelled `app.kubernetes.io/managed-by:
orchard-sandbox`, `orchard.my/sandbox-id`, `orchard.my/user-id` and
`orchard.my/instance=<instance id>`. The instance id is generated once and stored
in `instance_settings` (`sandbox_instance_id`); `instanceId()` must stay
byte-identical because the shard selector and the orphan sweep depend on it.

The pod template: one container named `sandbox`, the configured image,
`command: bash /orchard-init/bootstrap.sh`, `restartPolicy: Never`,
`automountServiceAccountToken: false`, `enableServiceLinks: false`, optional
`runtimeClassName`. Requests 250m/512Mi, limits from the row. Env
`SANDBOX_REPO_URL`, `SANDBOX_HOME_MODE`, and `GIT_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` from optional Secret keys. Volumes:
`authkeys` (the Secret's `authorized_keys`, mounted at
`/etc/ssh/authorized_keys.d`) and `init` (bootstrap, setup, opencode auth and
config, env bundle at mode 600, mounted at `/orchard-init`).

Home volume: a `home` claim template. In `block` mode (default when a
RuntimeClass is set) it is `volumeMode: Block`, attached at `/dev/sandboxhome`,
formatted ext4 and mounted at `/persist` inside the guest, which needs a
privileged container inside the Kata VM. In `filesystem` mode it is mounted at
`/persist` directly, unprivileged. A fork's claim template has a `dataSource`
pointing at the VolumeSnapshot.

Stop patches `operatingMode: Suspended`; the controller deletes the pod and keeps
the PVC. Start applies the CR with `Running`.

### Mirror shard

`sandboxes` in `mirror/mirror-shards.ts`, built only when sandboxes are enabled
and the Kubernetes runner is enabled, lease `orchard-mirror-sandboxes`, every
resource selected by `orchard.my/instance=<id>`:

| Resource                | Why                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox`               | Status. Events go to `SandboxMirrorConsumer.onEvent`; list passes to `onListComplete`.                                                                           |
| `Pod`                   | Pod name and IP for exec, the SSH tunnel and the agent proxy.                                                                                                    |
| `PersistentVolumeClaim` | `status.capacity.storage`, reported as `diskObserved`.                                                                                                           |
| `Secret`                | Metadata only: `sanitize: stripSecretData` deletes `data` and `stringData` before the object is persisted. The spec-hash annotation shows whether a sync landed. |

`onListComplete` runs two passes:

1. **Orphan sweep.** CRs carrying this instance's label with no row are queued
   for `sandbox.destroy` with `sandboxId: null`.
2. **Drift reconcile.** For each Kubernetes row: `deleted` rows without an open
   destroy item are re-queued; otherwise if the CR's `operatingMode` disagrees
   with the desired state (or a `creating`/`starting` row has no CR at all), a
   secret sync and a CR apply are queued, unless a CR item is already open.

`canTrustAbsence()` is true only when the shard's heartbeat has a holder, is
healthy, has completed a list, and was updated in the last 60 s. Nothing acts on
a resource being missing (stuck-transition errors, start rebuilds) unless that
holds. With `ENGINE_DISABLED=true` the runner reads the API server directly and
the reaper syncs Kubernetes rows itself.

### Connectivity

`httpTarget(ref, port)` is `http://<podIP>:<port>` from the mirror, or `{kind:
'exec'}` with `SANDBOX_TUNNEL_MODE=portforward` (the agent proxy then runs `curl`
inside the pod with the body on stdin). `openTcp` is a raw socket to the pod IP,
or a Kubernetes port-forward in portforward mode.

## Vercel runner

- **Create:** `Sandbox.create({name: podName, image, resources: {vcpus},
timeout, ports: [4096, 2222, 3000, 3001, 4173, 5173, 8000, 8080, 8787],
persistent: true, tags: {orchard_instance, orchard_sandbox, orchard_user},
networkPolicy})`. Ports are checked against the allowlist (max 15).
- **Start:** `Sandbox.get({name, resume: true})`, then `update({networkPolicy})`;
  a 404 creates (or forks) instead. **Stop:** `stop()`. **Destroy:**
  `delete({deleteOrphanSnapshots: true})`. **Fork:** `Sandbox.fork({sourceSandbox})`
  from the source's last snapshot, once (`runnerState.forkedAt`).
- **Exec:** `runCommand({sudo: true})`; streams use `detached` plus `logs()`.
  Stdin is written to `/tmp/orchard-stdin-<uuid>` (0600) and redirected, then
  removed. `writeFiles` stages into `/tmp/orchard-write-<uuid>` and moves with
  `su` when a user is given. `readFile` uses `readFileToBuffer`.
- **PTY:** `session.openInteractive()` gives `{url, token}`. The runner polls
  `GET /health`, opens `wss://...?token=`, sends `{type: 'start', command:
'sudo', args: ['-n', '/bin/sh', '-c', 'exec ...'], env: ['TERM=xterm-256color'],
cwd: '/', cols, rows}`, then binary stdin frames and `{type: 'resize'}`;
  receives binary output and `{type: 'exit', code}`.
- **HTTP:** `httpTarget` is `session.domain(port)`; for 4096 it adds
  `Authorization: Basic opencode:<password>`. Only allowlisted ports resolve.
- **TCP:** only port 22, through `wss://domain(2222)` with
  `Authorization: Bearer <bridge token>` to the in-machine bridge
  (`orchard sandbox bridge --listen 0.0.0.0:2222 --target 127.0.0.1:22
--token-file /orchard-init/bridge-token`, constant-time token compare, token
  file re-read per connection).
- **Init:** files from `stagedInitFiles()` written to `/tmp/orchard-init/*`
  (secret ones 0600), then bootstrap run detached with env `ORCHARD_INIT_STAGE`,
  `SANDBOX_HOME_MODE=none`, `SANDBOX_PERSIST_ROOT=/vercel/sandbox/orchard`,
  `SANDBOX_REPO_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`,
  `ORCHARD_BRIDGE_URL` and `ORCHARD_BRIDGE_SHA256`. Never `create({env})`.
- **Bridge integrity:** `BridgeChecksumResolver` returns `bridgeBinarySha256`
  when configured, or, for the default URL, the `orchard_<v>_linux_amd64.tar.gz`
  line of that release's `checksums.txt` (fetched once, cached; failures retried
  after 5 minutes). An overridden `bridgeBinaryUrl` without a checksum is a
  `configError`. The bootstrap refuses to install the bridge without
  `ORCHARD_BRIDGE_SHA256` and checks the download with `sha256sum -c`.
- **GitHub credential brokering:** `networkPolicy: {allow: {'github.com':
[{transform: [{headers: {authorization: 'Basic <x-access-token:TOKEN>'}}]}],
'api.github.com': [{... 'Bearer TOKEN'}], '*': []}}`. The host's token never
  enters the machine; the secret sync op updates the policy.
- **Poller:** the reaper tick (leader, every 60 s) calls `syncPolledRunners()`:
  `reconcile` with concurrency 5 over rows in `creating|starting|running|stopping`,
  then `keepAlive` for running rows. A Vercel API failure logs and leaves rows
  alone. `keepAlive` calls `extendTimeout(30 min)` when the row is not idle and
  `expiresAt` is within 10 minutes. `canTrustAbsence()` is true when the API
  answered in the last 120 s.
- A live-session cache keeps `Sandbox.get` results for 15 s.

## Bootstrap

`SANDBOX_BOOTSTRAP_SCRIPT` runs on every start, on both runners, and is
idempotent. It writes the current phase to `/tmp/orchard-boot-phase`
(`starting, packages, runtime, agents, storage, account, services, ready`),
which `GET /sandboxes/:id/boot` reads.

1. Moves staged init files into `/orchard-init` (Vercel).
2. Installs only what is missing with apt, dnf or yum: `sshd`, `git`, `curl`,
   `tmux`, `ripgrep`, `ss`, `pgrep`, `sudo`, and on bare images build tools,
   Python, `jq`; Node.js 22 from NodeSource; `claude`, `codex`, `opencode` from npm.
3. Writes `/etc/tmux.conf` (256 colours, 50k history, mouse, no status bar).
4. Mounts the block home (`block` mode) or links `/persist` to
   `SANDBOX_PERSIST_ROOT`; creates `/persist/home` and `/persist/hostkeys`.
5. Creates `dev` (uid 1000, home `/persist/home`, passwordless sudo), host keys
   in `/persist/hostkeys`, and `sshd_config.d/00-orchard.conf` (key auth only,
   `AllowUsers dev`, `AuthorizedKeysFile /etc/ssh/authorized_keys.d/authorized_keys`).
6. With `GIT_TOKEN` (Kubernetes) writes `~/.git-credentials` and the `store`
   helper for the agent's own git use.
7. Exports agent tokens in `/etc/profile.d/sandbox-agents.sh`.
8. Clones `SANDBOX_REPO_URL` in the background (`~/.clone.log`); runs the machine
   setup script once (`~/.setup.log`, marker `/persist/.setup-done`).
9. Syncs attached-project env files and installs `/etc/profile.d/orchard-env.sh`.
10. Links opencode config and auth from `/orchard-init`, writes
    `~/.config/opencode/server.env` with `OPENCODE_SERVER_PASSWORD` (restarting
    a running `opencode serve` when the password changed), starts
    `opencode serve --hostname 0.0.0.0 --port 4096`.
11. Installs and starts the SSH bridge when a bridge token exists (Vercel).
12. `exec sshd -D` (Kubernetes) or exits if sshd already runs.

## Secrets

`SandboxSecretsService.forSandbox(row)` assembles, at apply time:
`authorizedKeys` (every SSH identity of the host), the host's GitHub token,
Claude and OpenAI tokens (decrypted from `sandbox_credentials`), the setup
script, a 60-day MCP JWT, the opencode password, the bridge token, and the
attached-project env files.

- **Derived secrets:** `deriveSandboxSecret(purpose, id, key, epoch) =
base64url(HMAC-SHA256(SECRETS_ENCRYPTION_KEY, "orchard-sandbox:<purpose>:<id>[:<epoch>]"))`
  for `opencode-password` and `bridge-token` (epoch 0 omits the suffix, so
  machines from before the epoch keep their values). Never stored. Vercel refuses
  to run without the key.
- **Secret epoch:** `sandboxes.secret_epoch` (migration
  `20261008190000_sandbox_secret_epoch`). `rotateMachineSecrets` (member
  offboarding, on removing or downgrading a guest) increments it, revokes the
  machine's MCP session and queues a secret sync. `forSandbox` and every
  `httpTarget`/`openTcp` read the epoch fresh through `SandboxSecretsService.boxSecret`,
  so the server switches immediately. The sync then moves the box: Kubernetes
  replaces the Secret and runs `OPENCODE_PASSWORD_ROTATE_SCRIPT` with the new
  password on stdin (rewrites `server.env`, kills `opencode serve` only when the
  password changed, starts it again); Vercel restages the init files and reruns
  the bootstrap, whose `opencode_password_sync` does the same, and the bridge
  reads the new token file per connection. Until opencode is back, the proxy maps
  upstream `401` to `503 {code: 'agent_restarting'}` and ends streams cleanly.
- **Spec hash:** `sandboxSpecHash` is a keyed HMAC of the canonical Secret data,
  truncated to 32 hex characters, written as `orchard.my/spec-hash`.
- **MCP token:** when `SANDBOX_MCP_URL` is set, a JWT of type `mcp` bound to a
  dedicated session (`deviceName: sandbox-mcp`) of the host, written into the
  opencode config as an `orchard` remote MCP server. Vercel only accepts an
  `https://` URL. Revoking that session revokes it.

## Sessions

A session is a `SandboxConversation` row with a `slug`.

| Column                                                      | Meaning                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `slug`                                                      | `slugify(title or issue hint) + 6 hex`, unique per machine |
| `repo`                                                      | Directory name under `/persist/home`                       |
| `branch`                                                    | `orchard/<slug>`                                           |
| `worktreePath`                                              | `/persist/home/.worktrees/<repo>/<slug>`                   |
| `baseBranch`, `baseCommit`                                  | What the worktree branched from                            |
| `opencodeSessionId`                                         | The primary chat (`ses_...`)                               |
| `prUrl`, `prNumber`, `prState`                              | Recorded on PR creation, refreshed by the checks endpoint  |
| `previewDeploymentId`, `previewEnvironmentId`, `previewUrl` | Preview environment                                        |
| `createdById`, `archivedAt`                                 |                                                            |

- **Create:** validates repo and ref names, inserts the row (retrying slug
  collisions), runs `buildWorktreeAddScript` (fetch base, `git worktree add
--no-track -b orchard/<slug>`), creates an opencode session with
  `directory=<worktree>`, installs the co-author hook, sends the first prompt
  with `prompt_async` under a fresh `messageID` recorded as the creator's
  `SandboxPromptAuthor` (so CLI, MCP, Slack, Linear and GitHub kickoffs are
  attributed too), and starts the setup script if configured. Exit codes 3/4/5/6
  map to not a repo, exists, no base, add failed.
- **Archive:** kills the session's tmux sessions, removes the worktree, keeps the
  branch, tears down any preview. **Restore** re-adds the worktree from the branch.
  **Delete** also purges `~/.orchard/sessions/<id>`, deletes the opencode session
  and optionally the branch.
- **List** decorates active rows with one batched exec for diffstat and
  ahead/behind against `origin/<base>` (falling back to `baseCommit`), and with
  activity from opencode `GET /session/status?directory=` (`busy` or `retry`
  means working).
- **Chats** are opencode sessions whose `directory` is the worktree.
- Workspace routes (`changes`, `diff`, `file`, `git/*`, `fs/*`) take
  `session=<id>`, which resolves the cwd to the worktree; every script runs
  behind a `realpath` guard that the directory is inside `/persist/home/.worktrees`.
- `GET file` (`buildConfinedReadScript`), `GET diff?file=`
  (`buildConfinedPathCheck`, `realpath -m`) and `fs/*` resolve the target with
  `realpath` in the box and refuse (exit 5, a 400) anything outside the root, or
  under a dot entry of `/persist/home` other than `.worktrees`, so symlinks to
  `~/.git-credentials`, `~/.config` or `~/.claude` do not leak to viewers. The
  file is returned base64 from `head -c`.

### Scripts and ports

`.orchard/greenhouse.json` (`setup`, `run`: string or string array, `ports`) is
read from the worktree, then the repo root, capped at 64 KB. Launching writes
`~/.orchard/sessions/<id>/<name>.user.sh` and a wrapper, then starts tmux
session `orchard-<sid8>-<name>` (`remain-on-exit`, output piped to
`<name>.log`, a `tmux wait-for` channel so no output is lost). The wrapper exports
`ORCHARD_SESSION_ID`, `ORCHARD_WORKSPACE_PATH`, `ORCHARD_ROOT_PATH` and writes
`<name>.status` (`running`, `done`, `failed <code>`).

Ports come from `/proc/net/tcp{,6}` listening sockets mapped to processes owned
by `dev` through `/proc/<pid>/fd`, with the process `cwd` deciding `inSession`
and the bind address deciding `loopbackOnly`. 22, 2222 and 4096 are hidden.

`ports` in the config is bounded: up to 10 entries from 1024 to 65535, never 22,
2222 or 4096. Every probe merges them into `runnerState.declaredPorts` (capped
at 10, newest first, standard preview ports left out) and asks the runner
(`requestPreviewPorts`) for the per-machine NetworkPolicy. `GET ports` adds
declared ports that nothing listens on (`listening: false, declared: true`).

### Pull requests, checks, merge

PR creation reads the remote, the branch and whether `@{u}` is `origin/<branch>`
with no commits ahead (`PR_STATE_SCRIPT`); otherwise it runs `git push -u origin
HEAD` as the actor first. It then calls the GitHub REST API with the actor's
token, from the session branch into `body.base`, the session's base branch, or
the repository default, with `draft: true` when asked, and returns `pushed`.
Checks read the PR (by number, or by head branch) and its head commit's check runs
and statuses with the actor's token, falling back to the host's; failing GitHub
Actions jobs get the last 60 lines (6 KB) of their logs, at most three. Merge is
`PUT /pulls/:n/merge` with `squash` (default) or `rebase`.

## Git identity per person

`sandbox-git-identity.ts`. Every git write made through Orchard runs as the
actor:

- `gitIdentity(user)`: name from the Orchard profile or GitHub login; email
  `<githubId>+<login>@users.noreply.github.com` when GitHub is linked, else the
  Orchard email, else `sandbox@orchard.dev`. Exported as `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*`.
- Network operations need the actor's token (`GitHubNotLinkedException`,
  `{code: 'github_not_linked'}`, 409 otherwise). The token is sent on the exec's
  **stdin**, read into `ORCHARD_GIT_TOKEN`, and used through `-c
credential.helper=` (clearing any configured helper, including the host's
  `store` helper) followed by an inline helper that echoes the variable. It is
  never in argv, git config or on disk.
- Guest terminals: an env file with the identity, `GIT_CONFIG_*` entries for the
  helper and `ORCHARD_GIT_TOKEN` is written to `/tmp/.orchard-term-<engine id>`
  (umask 077), sourced by the shell and deleted (a 30 s cleanup covers the
  attach path). The values are also set in the tmux session environment.
- Commits through the API add `Co-authored-by` for other people who prompted in
  the session (`SandboxMembersService.coAuthors`). The agent itself runs as the
  host.
- Agent commits (and any `git commit` in the worktree) get trailers from a
  `prepare-commit-msg` hook (`sandbox-coauthors.ts`): at session create and
  restore the worktree gets `extensions.worktreeConfig` and a per-worktree
  `core.hooksPath` of `~/.orchard/sessions/<id>/hooks`, a dispatcher symlinked
  under every client hook name that first runs the repo's own hook (repo-level
  `core.hooksPath`, then global, then `$GIT_COMMON_DIR/hooks`). It appends
  `Co-authored-by: <line>` with `git interpret-trailers --if-exists
addIfDifferent` for each line of `~/.orchard/sessions/<id>/coauthors`, skipping
  the commit's own author and names already present. `SandboxCoauthorsService`
  rewrites that file on every recorded prompt: when opencode reports the chat
  busy (or cannot be asked) the author is appended, otherwise the file is reset to
  this author, so it holds the current turn. The host is never listed.

## Terminals

`sandbox-terminal.gateway.ts` registers a route on the shared exec-session engine
(`kubernetes/exec-session-engine.ts`), the same engine as pod shells: protocol
v2, snapshot resume, persisted handles, a Redis directory and cross-replica
proxying, detach grace, recheck every 15 s.

`WS /apiv1/sandboxes/:id/terminal?proto=2&cols&rows&session=<handle>&sid=<session>&n=<index>&mode=rw|ro&user=<owner>`

- `n` is `0` to `99`, `setup` or `run`. Without `sid` only `n=0` is allowed (a
  machine shell in `/persist/home`, tmux `orchard-<engine session id>`, needs `rw`).
- `rw` needs guest or host; anyone else is downgraded to `ro`. `setup` and `run`
  are always `ro` attaches to the script's tmux session, falling back to tailing
  its log.
- Terminals are per person: the host's are tmux `orchard-<sid8>-<n>`, a guest's
  `orchard-<sid8>-<n>-u<userid32>`. Opening someone else's (`user=`) is always
  `ro`, which runs `tmux attach -r`.
- The command waits for the `dev` user, `cd`s to the worktree and runs
  `tmux -u new-session -A` (or `attach-session [-r]`) under `su -l dev`.
- Activity touches `lastActiveAt` every 60 s. Audit: `sandbox.terminal.open`,
  `.reattach`, `.denied`.

## SSH tunnel

`WS /apiv1/sandboxes/:id/ssh`: session JWT or an `orch_` token with the `exec`
scope, owner or superadmin only, machine running. Binary frames carry raw TCP to
`runner.openTcp(ref, 22)`. Limits: 8 connections per user, 200 per replica,
64 KB frames, backpressure at 4 MB. Access re-checked every 15 s (close code
4401). Audit `sandbox.ssh.connect`.

`GET /sandboxes/:id/hostkey` returns `/persist/hostkeys/*.pub`, cached in
`runnerState.hostKeys` for stopped machines. `GET /sandboxes/:id/connect` returns
`{sshHost: 'orchard-<name>', user: 'dev', sshReady}`. The CLI's
`ssh-config --install` and `proxy --host` use both; see the user docs.

## Live gateway

`WS /apiv1/sandboxes/:id/live?sid=<session>`, JSON text frames, 64 KB max.

- **Auth:** session cookie (`session_token`, or `__Host-session_token` on a secure host-only instance) or bearer (session JWT, or `orch_` token with
  `exec` and no project restriction). `Origin` must be `FRONTEND_URL` or in
  `PLATFORM_ORIGINS`; a missing origin is only accepted for bearer and API-token
  auth. Org-scoped sessions only reach machines of that org.
- **Limits:** 16 connections per user per machine, 4000 per replica; ping every
  25 s.
- **Role per message** (server enforced, `forbidden` error otherwise):

| Client frame                                                         | Min role                            | Rate (per second, burst) |
| -------------------------------------------------------------------- | ----------------------------------- | ------------------------ |
| `hello {sid, view}`                                                  | viewer                              | control 10, 20           |
| `presence {sid, view: {tab, file, line, col, selection, scrollTop}}` | viewer                              | 20, 20                   |
| `draft {sid, chatId, text}` (4000 chars)                             | collaborator                        | 10, 10                   |
| `comment {sid, chatId, body}` (4000 chars)                           | collaborator                        | 1, 5                     |
| `follow {target}`                                                    | viewer                              | 20, 20                   |
| `yjs {room, b64, gen}`                                               | viewer (writes dropped for viewers) | 60, 120                  |
| `yjs-awareness {room, b64}`                                          | viewer                              | 30, 30                   |
| `yjs-save {room}`                                                    | collaborator                        | control                  |
| `yjs-reload`, `yjs-leave {room}`                                     | viewer                              | control                  |
| `ping`                                                               | viewer                              | control                  |

- **Server frames:** `welcome {connId, user, role}`, `roster {sid, users}`,
  `presence {user, sid, view}`, `draft {user, sid, chatId, text}`,
  `prompt {sid, user, chatId, messageId}`, `comment {sid, comment}`,
  `session {session}`, `session-deleted {id}`, `follow {user, target}`,
  `role {role}`, `kicked {reason}` (close 4403), `error {code}`, `pong`, and the
  Yjs frames `yjs`, `yjs-awareness`, `yjs-error`, `yjs-denied`, `yjs-reset`,
  `yjs-disk`, `yjs-saved`.
- **Fan-out:** Redis pub/sub on `sbx-live:<sandboxId>` with envelopes `frame`,
  `roster`, `acl` and the Yjs envelopes; presence in hash
  `sbx-presence:<sandboxId>` (entries live 45 s, hash TTL 90 s). Without Redis an
  in-memory backend serves a single replica.
- **ACL:** every connection re-resolves its role every 15 s; membership changes
  publish `acl`, which rechecks the affected user's connections on every replica
  at once, sending `role` or kicking.
- Text is stripped of control and bidi characters. Drafts are never stored.

### Yjs rooms

Room `file:<sessionId>:<relative path>` (path normalised, no `..`, no `.git`).

- **Ownership:** one replica owns each room's `Y.Doc`, claimed with
  `sbx-yroom:<room>` (TTL 15 s, heartbeat 5 s). Other replicas forward `y-in`
  envelopes to the owner and deliver `y-out`; subscribers heartbeat with `y-sub`
  (TTL 30 s). Losing the claim destroys the doc and sends `yjs-reset`.
- **Seed:** from disk on first join (files up to 500 KB, 1 M characters).
- **Agent edits:** the owner polls the file's hash every 3 s and merges disk
  changes into the doc as a minimal diff against the last saved base (`yjs-disk`).
- **Save:** 2 s debounce after a change, or `yjs-save`; re-merges disk first,
  writes, broadcasts `yjs-saved`. Over 500 KB fails with `yjs-error`.
- **Awareness:** at most 4 client ids per subscriber, 8 KB state, and the server
  overwrites the `user` field with the real identity and role.
- Viewers' document updates are dropped (`yjs-denied`). Empty rooms are flushed
  and destroyed after 60 s.

## Agent proxy and prompt attribution

`ALL /apiv1/sandboxes/:id/opencode/*` proxies to opencode on 4096 (direct URL,
Vercel URL with Basic auth, or exec with `curl --data-binary @-`).
`opencodeMinRole(method, path)`:

- Viewer reads: `/event`, `/session`, `/session/status`, `/session/:id`,
  `/session/:id/{message,children,todo,diff}`, `/agent`, `/command`, `/project`,
  `/vcs`, `/lsp`, `/formatter`, `/path`.
- Owner only: `/config`, `/auth`, `/mcp`, `/pty`, provider OAuth, session
  share, `/instance`, `/global`, `/tui`, `/experimental`, `/project/:id`, `/doc`
  (GET of config, mcp and provider allowed to collaborators; `/global/event` to
  viewers).
- Everything else, and every write: collaborator.

For `POST /session/:chat/{prompt_async,message,command}` the proxy validates or
assigns `messageID` (`msg_` + 12 hex timestamp + 14 base62), records
`SandboxPromptAuthor {sandboxId, sessionKey, opencodeSessionId, messageId,
userId}` (unique per machine; a reused id by someone else is a 409) and
broadcasts `prompt`. `POST /sessions/:sid/prompt` (CLI, MCP) does the same
server side. `GET /sessions/:sid/authors` maps message ids to people.

`/chat` comments are `SandboxSessionMessage` rows, posted over REST or live and
broadcast as `comment`.

## Previews

`SandboxPreviewService`, mounted as the first Express middleware and the first
upgrade handler, matches `Host: <port>-<id8>.<previewDomain>`.

- `GET /sandboxes/:id/preview-token?port=` (viewer, rate 0.5/s burst 20 per
  user): Vercel returns `domain(port)` with `public: true`. Kubernetes mints a
  token `{jti, sid, uid, port, exp: 60 s}` signed with
  `HMAC(JWT_SECRET, "orchard-preview:token")`, stores `sbx-preview-token:<jti>`
  in Redis or memory, and returns
  `https://<port>-<id8>.<domain>/__orchard_preview?token=...`.
- `/__orchard_preview` takes the jti (single use), re-checks access, sets
  `orchard_preview` (signed with the cookie key, bound to host and port,
  `HttpOnly; Secure; SameSite=Lax; Path=/`, 12 h) and redirects to `/`.
- Requests need a valid cookie and current access (cached 15 s), pass
  `previewRequestAllowed` (Origin must be the same preview host; cross-site
  `Sec-Fetch-Site` only for top-level GET navigations), then are piped through
  `runner.openTcp(ref, port)` for HTTP and WebSocket. `Authorization`, cookies
  named `orchard*`, both session cookie names, OAuth state cookies, `X-Orchard-*` and
  forwarding headers are stripped upstream; `Set-Cookie` loses `Domain` and
  `orchard*` cookies downstream.
- Ports: 3000, 3001, 4173, 5173, 8000, 8080, 8787, on both runners, plus the
  machine's `runnerState.declaredPorts` on Kubernetes (checked per request after
  the cookie names the machine).
- Every other raw upgrade handler (exec-session engine for pod and sandbox
  terminals, SSH, live) skips requests whose `Host` is a preview host; `main.ts`
  passes `previewService.isPreviewHost` to them.
- `previewDomainConflict()` rejects a preview domain equal to, under, or above
  `COOKIE_DOMAIN`, the hosts of `FRONTEND_URL`, `API_URL` and `PLATFORM_ORIGINS`,
  at config save and again at runtime.

## Attention notifications

`SandboxAttentionService`, leader only, every 20 s: sessions with a recorded
prompt in the last 6 h on running machines; reads activity per worktree; a
`working` to `idle` transition sends `sandbox.session.needs_input` through
`NotificationsService.notifyAccount` to the host and recent prompters who are
still members, skipping anyone connected to the machine's live gateway. Dedupe
key per session, user and minute.

## Project links and preview environments

- `SandboxProjectLink {sandboxId, projectId, environmentId, createdById}`.
  Attach requires host and project edit; `SandboxProjectEnvService.filesFor`
  renders `<project-slug>.env` from the environment's shared variables (secret
  values omitted, shell-reserved keys skipped) plus `DATABASE_URL` for the first
  CNPG database when public access is on. Re-rendered on secret sync;
  `onEnvironmentEnvChanged` queues syncs for linked machines; links whose creator
  lost edit access are skipped. In the machine: `~/.config/orchard/env/*.env`,
  mode 600, loaded by `/etc/profile.d/orchard-env.sh`.
- Preview deploy (`POST /sandboxes/:id/sessions/:sid/preview-deploy`, host,
  project edit): pushes the branch as the actor, ensures environment
  `gh-<slug>` (never a default or production environment, never one claimed by
  another session), clones the source deployment's config (skipping env vars
  that reference other resources), creates or rebuilds, creates the auto
  ingress, records the URL from `scrubIngress`. Teardown deletes the environment
  on remove, archive or delete.

## Forks and share links

- **Fork** (`POST /sandboxes/:id/fork`, owner only, counts against the cap):
  new row with `runnerState.forkFrom`, copies of active session rows (without
  chat ids), then `requestFork`. Kubernetes: snapshot op, CR waits for the
  snapshot. Vercel: `Sandbox.fork` of the last snapshot.
- **Share links** (`SandboxShareLink`): 32 random bytes base64url, stored as
  SHA-256, compared in constant time. Scope: one session or all active sessions.
  Expiry 1 to 720 h, default 168. Max 50 active per machine. Viewer routes under
  `/apiv1/share/sandbox` (token in `X-Orchard-Share-Token`, which the page reads
  from the URL fragment `/share/sandbox#<token>`) and the older
  `/apiv1/share/sandbox/:token` require a signed-in, non-guest member of the
  machine's org, are rate limited (60/min plus the `sandbox_share` user limit),
  serve only `view`, `transcript`, `changes` and `diff`, and audit
  `sandbox.share_link.use` at most every 10 minutes per user and link. Datadog's
  `http.url`/`http.endpoint` and error reports replace a path token with
  `[redacted]` (`analytics/url-redaction.ts`).

## Integrations

`sandboxes/integrations`, all funnelled through `GreenhouseKickoffService.start`:

- Enabled check (sandboxes on, and the `greenhouse` flag when PostHog is
  configured), per-user rate limit of 5 per minute (Redis or memory), machine
  choice (`chooseMachine`: running machines of the user with a matching
  `origin`, then a mentioned repo name, then the latest session's machine), role
  check, the untrusted-author rule (an issue written by someone who is not host or
  guest needs a host to start it), `sessions.create`, audit
  `sandbox.session.started_from`.
- Issue text is wrapped in `<untrusted-issue>` tags with an instruction not to
  follow it, truncated at 8 KB.
- **GitHub:** `issue_comment` on the App webhook (the App manifest asks for
  `issues: write` and the `issue_comment` event), `/greenhouse` prefix, not a PR,
  not a bot, sender must equal comment author, mapped by `User.githubId`. Replies
  with an installation token.
- **Slack:** `POST /integrations/slack/commands` and `/events`, signature
  `v0=HMAC(signingSecret, "v0:<ts>:<body>")` within 300 s, optional `api_app_id`
  filter. `link` creates a `SlackLinkToken` (hashed, 10 minutes, single use) and
  `/integrations/slack/link?token=` confirms it into `UserIntegration
{provider: slack, externalId: "<team>:<user>"}`. A leader poller (20 s) watches
  `SlackThreadLink` rows and posts when the agent goes from working to idle (or
  after a 90 s grace), expiring after 6 h.
- **Linear:** `POST /integrations/linear/webhook`, hex HMAC of the body in
  `Linear-Signature`, `webhookTimestamp` within 300 s, `Comment` create events
  only. Users connect a personal API key (`PUT /users/me/integrations/linear`),
  verified with `viewer`, encrypted, and keyed by Linear user id. Replies go out
  with the commenter's key.
- Deliveries are deduped in `sandbox_integration_deliveries` (7 days).

## Access model

`SandboxAccessService.sandboxRoleOf` resolves, in order: no user or an
org-scoped session for another org or a project-restricted token gives nothing;
superadmin is `owner`; the creator is `owner`; otherwise the user must be an org
member, then `collaborator` or `viewer` membership, then org admin (`admin`).
`requireSandboxRole(min, {orgAdmin})` gates routes; `admin` passes nothing
except routes with `orgAdmin: true` (get, boot, start, stop, delete, apply
retry), and an invited org admin keeps the `orgAdmin` flag for those. The live
gateway and preview proxy resolve through `resolveInside`, which drops `admin`;
terminals go through `requireSandboxRole`, so admins get neither rw nor ro.

| Minimum      | Routes                                                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| viewer       | get and boot (also org admin), sessions list/get, chats, scripts, ports, checks, changes, diff, file read, branches, git identity, repos, conversations, members list, comments list, authors, transcript, preview token, links list, opencode reads |
| collaborator | sessions create/update/delete, chats create, run, fs ops, file write, commit, uncommit, push, pull, fetch, checkout, branch delete, PR, merge, prompt, comments, opencode writes, issues, start (also org admin)                                     |
| owner        | update, hostkey, connect, ssh, add repo, members add/update, share links, fork, links attach/detach, preview deploy; stop, delete and apply retry (also org admin)                                                                                   |

`Sandbox feature is not enabled` (404) comes from `SandboxEnabledGuard`, which
caches `InstanceSettingsService.isSandboxesEnabled()` for 10 s
(`sandboxes_enabled`, env `SANDBOX_ENABLED` locks it, `SANDBOX_ENABLED_DEFAULT`
sets the unlocked starting value, default on outside production). The SSH
gateway authenticates with the engine's `authenticateUpgrade` and authorizes
through `sandboxSshAccess` (owner, run inside the session's org scope and the
token's project restriction), like terminals.

## Reaper

Leader only, every 60 s, when sandboxes are enabled:

1. `syncPolledRunners` (Vercel).
2. With `ENGINE_DISABLED`, observe Kubernetes rows directly.
3. Rows `creating`/`starting` for 10 minutes (30 for a fork still carrying
   `runnerState.forkFrom`) become `error`, but only when the runner can trust
   absence.
4. Idle stop after `SANDBOX_IDLE_TIMEOUT_MINUTES` (default 60) of no
   `lastActiveAt` updates (terminals, SSH, start), unless a `claude`/`codex`
   process or a busy opencode session is found. Audit `sandbox.idle_stop`.
5. Max lifetime: `startedAt` older than `SANDBOX_MAX_LIFETIME_HOURS` (default 168)
   is stopped. Audit `sandbox.lifetime_stop`.

## Data model

| Table                             | Holds                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandboxes`                       | Machine: owner, org, name, `runner`, `desiredState`, `status`, `podName`, `namespace`, `externalId`, `runnerState`, image, limits, disk, setup script, SSH identity, `lastActiveAt`, `startedAt` |
| `sandbox_conversations`           | Sessions (with `slug`) and legacy conversations                                                                                                                                                  |
| `sandbox_credentials`             | Encrypted Claude and OpenAI tokens per user                                                                                                                                                      |
| `ssh_identities`                  | Public keys per user                                                                                                                                                                             |
| `sandbox_members`                 | `viewer` or `collaborator`, invited by                                                                                                                                                           |
| `sandbox_prompt_authors`          | Who sent each agent message                                                                                                                                                                      |
| `sandbox_session_messages`        | `/chat` comments                                                                                                                                                                                 |
| `sandbox_project_links`           | Attached project environments                                                                                                                                                                    |
| `sandbox_share_links`             | Hashed read-only share tokens                                                                                                                                                                    |
| `user_integrations`               | Linked Slack and Linear accounts (Linear key encrypted)                                                                                                                                          |
| `slack_link_tokens`               | Pending Slack link confirmations                                                                                                                                                                 |
| `slack_thread_links`              | Slack threads waiting for an agent to finish                                                                                                                                                     |
| `sandbox_integration_deliveries`  | Webhook dedupe                                                                                                                                                                                   |
| `k8s_apply_queue.sandbox_id`      | Apply items per machine                                                                                                                                                                          |
| `k8s_objects` (shard `sandboxes`) | Mirrored CRs, pods, PVCs, Secret metadata                                                                                                                                                        |

## Residual risks

- Guests act through the host's agent, subscription and files; the product
  discloses this on both sides rather than preventing it.
- A guest's GitHub token is present in their own terminal's environment on the
  host's machine while it is open.
- Vercel persistent snapshots contain the machine's secrets (opencode auth with
  the Claude token, the derived passwords, env files).
- On Kubernetes the home volume holds `~/.git-credentials` with the host's
  GitHub token for the agent.
- The agent's MCP token lets anyone who can prompt the agent reach Orchard as the
  host.
- Issue bodies are untrusted input to an agent with the host's credentials; they
  are fenced and gated by the author rule, not sanitised.
