---
title: Running Greenhouse
description: Turn on Greenhouse, set up the Kubernetes and Vercel runners, previews and integrations, and understand its security model.
sidebar:
  order: 8
---

[Greenhouse](/greenhouse/) gives people cloud machines with coding agents on
them. This page is for the operator: what it needs, how each runner is set up,
every setting, and what the security model is.

The internal design, with the data model and the apply operations, is in
`docs/ai-sandbox.md` in the repository.

## Turning it on

Greenhouse is a [graft](/grafts/overview/), one of Orchard's extensions. It is
published to the Extension Marketplace from the Orchard repository and installed
like any other graft:

```sh
sudo orchardctl graft add greenhouse --apply
```

or, for GitOps, in the Orchard chart values:

```yaml
grafts:
  - id: greenhouse
    version: 1.0.0
    digest: sha256:...
```

The [marketplace page](https://orchard.my/extensions/greenhouse) shows the exact
snippet with the digest. Installing it rolls Orchard out the same way an upgrade
does, with no downtime. Removing the entry turns Greenhouse off; its data stays in
the database until you run `orchardctl graft remove greenhouse --purge`.

Installed means on: the old admin switch and `SANDBOX_ENABLED` /
`SANDBOX_ENABLED_DEFAULT` no longer exist and are ignored if still set. The
chart's `sandbox.install` still renders the namespace, quota, NetworkPolicy,
RBAC and `SANDBOX_*` settings the Kubernetes runner needs; leave it on where
Greenhouse is installed.

### Upgrading from an Orchard that had Greenhouse built in

Earlier releases shipped Greenhouse inside Orchard. When the graft first starts it
moves Greenhouse's tables from the `public` schema into its own `ext_greenhouse`
schema, in one transaction, without copying or deleting anything, and leaves
views with the old names in `public` so pods still running the previous release
keep working during the rollout. Per-person machine limits move from the old
`users.max_sandboxes` column into `ext_greenhouse.user_limits`. Install the graft
in the same change that upgrades Orchard, or Greenhouse is unavailable until you
do (nothing is lost in between).

Machine limits per person are now set on **Instance admin → Greenhouse** instead
of the Users page.

When the instance has PostHog configured (`POSTHOG_API_KEY`), Greenhouse is also
gated per person by the `greenhouse` feature flag, which lets you roll it out to
a few people first. Without PostHog everyone on the instance gets it once it is
on.

## How it is wired

Every machine change goes through the same pipeline as deployments:

- **Writes are queued.** Creating, starting, stopping, deleting and syncing a
  machine's credentials record the desired state on the machine's row and add an
  item to the apply queue. Workers drain the queue, retrying with backoff (from 5
  seconds up to 10 minutes, ten attempts). The dashboard shows **Applying** and
  any apply error per machine.
- **Reads come from the mirror.** On Kubernetes, the `sandboxes` mirror shard
  watches the Sandbox resources, their pods, volumes and secrets (metadata only)
  and writes them to Postgres. Machine status, pod addresses and disk sizes are
  read from there, not from the API server.
- **Vercel is polled.** It has no watch API, so the leader polls Vercel every
  minute and writes what it sees into the same columns.

When a change runs out of attempts the machine keeps showing the error. The host
or an org admin can queue a machine's failed changes again with
`orchard sandbox retry <name>` (`POST /apiv1/sandboxes/:id/apply/retry`).

The queue only drains on a server that is a member of the cluster: in-cluster,
or out of cluster with `ORCHARD_CONTROL_NAMESPACE` set and a kubeconfig. A dev
server on a laptop that points at a production database can enqueue changes but
never applies them. `APPLY_WORKER_DISABLED=true` makes any replica enqueue only.

Instance configuration saved in the admin UI reaches every replica within 30
seconds.

## Kubernetes runner

### Prerequisites

1. **The agent-sandbox controller and its CRDs** from
   [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
   (`agents.x-k8s.io/v1beta1`), installed out of band at a pinned release. The
   chart does not install it.
2. **A namespace for machines**, `orchard-sandboxes` by default. The chart
   creates it (Pod Security `privileged`), a ResourceQuota, a LimitRange, the
   NetworkPolicy and the RBAC the server needs, when `sandbox.install` (or
   `sandbox.enabled`) is true.
   The server also applies the namespace and NetworkPolicy itself through the
   apply queue whenever it becomes leader, so they stay correct.
3. **Kata Containers** (optional, strongly recommended). With a Kata
   RuntimeClass each machine is a lightweight VM. Its home volume is attached as
   a raw block device and formatted inside the VM, which is fast for
   `node_modules`-heavy work and needs a privileged container inside the VM.
   Without Kata, leave `runtimeClassName` empty: machines run on `runc` with an
   ordinary filesystem volume and no privileges. A machine whose home volume is
   already a block device (created under Kata) refuses to start once
   `runtimeClassName` is empty, rather than running privileged on `runc`; put the
   RuntimeClass back or delete the machine.
4. **Storage.** A StorageClass for the home volumes (the cluster default unless
   you set one). For [forking](/greenhouse/machines/#forking), a
   VolumeSnapshotClass whose driver matches that StorageClass's provisioner;
   without one, forking is simply not offered on Kubernetes.

The server needs no image of your own. Machines start from `debian:bookworm` (or
the image you set) and a bootstrap script installs `sshd`, `git`, `tmux`,
Node.js 22, Claude Code, Codex and opencode on first boot. It handles apt and
dnf based images.

### What it creates

For each machine, all labelled `orchard.my/instance=<id>` and
`orchard.my/sandbox-id=<machine id>`:

| Resource                  | Name                    | Notes                                                                                   |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `Sandbox` (agent-sandbox) | `sbx-<id>`              | `operatingMode: Running` or `Suspended`. Stop suspends; the controller deletes the pod. |
| `Secret`                  | `sbx-<id>-auth`         | `authorized_keys`, the bootstrap and setup scripts, agent and GitHub tokens, env files. |
| `PersistentVolumeClaim`   | from the claim template | The home volume, mounted at `/persist`.                                                 |
| `VolumeSnapshot`          | `sbx-<id>-fork`         | Only while forking; deleted once the copy's volume is bound and the copy is running.    |
| `NetworkPolicy`           | `sbx-<id>-previews`     | Only when the machine's repositories declare extra preview ports. See below.            |

The instance label means a second Orchard install pointed at the same cluster
neither sees nor deletes these. The mirror's orphan sweep only removes resources
carrying this instance's label with no machine row behind them.

### Network policy

`sandbox-isolation` in the machine namespace:

- **Ingress** only from Orchard server pods, on TCP 22 (SSH), 4096 (the agent
  server) and the preview ports 3000, 3001, 4173, 5173, 8000, 8080 and 8787.
- **Egress** to kube-dns, and to the internet except 10.0.0.0/8, 172.16.0.0/12,
  192.168.0.0/16, 169.254.0.0/16 and 100.64.0.0/10. No cluster services, no
  other machines, no cloud metadata.

The chart renders this policy and the server applies the same object whenever it
becomes leader, so a `helm upgrade` and a leader election never fight over it
(`pnpm --filter server test:chart` fails if the two drift apart).

When a repository lists extra ports in `.orchard/greenhouse.json` (up to 10, from
1024 to 65535, never 2222 or 4096), the server applies one more policy for that
machine, `sbx-<id>-previews`, selecting only its pod and allowing only Orchard
server pods on those ports. NetworkPolicies add up, so this widens nothing for any
other machine. It is deleted with the machine.

Pods run without a service account token.

### Out-of-cluster servers

A server outside the cluster cannot reach pod IPs. Set `SANDBOX_TUNNEL_MODE=portforward`
(`sandbox.tunnelMode`) and it reaches SSH, the agent server and previews through
the API server's port-forward instead.

## Vercel runner

### What you need

- A Vercel **access token**, the **team id** and a **project id** to create
  sandboxes under.
- `SECRETS_ENCRYPTION_KEY` set on the server. Vercel ports are reachable from the
  internet, so each machine's agent server and SSH bridge are protected by secrets
  derived from that key, and the runner refuses to start without it.

### Settings

| Setting                | Default                         | Notes                                                                                                                             |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `vercelImage`          | `vercel/sandbox/universal`      | The image new machines start from.                                                                                                |
| `vercelVcpus`          | 2                               | 1 to 8.                                                                                                                           |
| `vercelTimeoutMinutes` | 60                              | Vercel's own stop timer. Orchard extends it by 30 minutes at a time while a machine is in use and not idle.                       |
| `vercelDriveGiB`       | 50                              | Size of each machine's drive. Applies to new drives only; a drive keeps the size it was created with. 0 turns drives off.         |
| `bridgeBinaryUrl`      | the release matching the server | An `https://` URL of the Linux amd64 `orchard` CLI tarball, run in each machine as the SSH bridge. Set it for air-gapped mirrors. |
| `bridgeBinarySha256`   | from the release's checksums    | SHA-256 of that tarball. Required when `bridgeBinaryUrl` is set; the runner reports itself unavailable without it.                |

Machines refuse to install a bridge they cannot verify. With the default URL the
server reads the expected SHA-256 from that release's `checksums.txt` on GitHub
(once, then cached) and passes it to the bootstrap as `ORCHARD_BRIDGE_SHA256`;
with your own URL it passes `bridgeBinarySha256`. A download that does not match,
or a start without a checksum, logs a line in the bootstrap output and leaves the
bridge out, so SSH to that machine fails until the checksum is available.

Machines are created as **persistent** sandboxes: stopping one snapshots it and
starting resumes from the snapshot. The snapshot is the whole root filesystem
(`/etc`, `/usr/local`, `/root`, `/tmp`), not only `/vercel/sandbox`; running
processes are not kept, so every start reruns the bootstrap, which restarts sshd,
the agent server and the bridge. Each machine exposes port 4096 (the agent
server), 2222 (the SSH bridge) and the seven preview ports.

### Persistence: drives and snapshots

Vercel expires a snapshot 30 days after it was taken unless told otherwise, which
would silently wipe any machine nobody opened for a month. Orchard prevents that
in two ways.

- **Snapshots never expire.** Every machine is created (and every existing one is
  updated on its next start, or by the leader's poll while it runs) with
  `snapshotExpiration: 0` and `keepLastSnapshots: { count: 3 }`, so its last three
  snapshots are kept until the machine is deleted. Vercel cannot change the expiry
  of a snapshot that already exists, so a machine stopped before this setting
  arrived keeps its old expiry until it is started once.
- **The home lives on a drive.** Each machine gets its own
  [Vercel drive](https://vercel.com/docs/sandbox/concepts/drives) named
  `orchard-<machine id>`, created in the machine's region with `vercelDriveGiB` of
  space and mounted read-write at `/mnt/orchard-drive`. `/persist` (home,
  repositories, worktrees, agent history, SSH host keys, the setup-done flag)
  points there. Drives never expire, and the drive's name is kept in the
  machine's `runner_state.driveName`, so if the sandbox itself is lost the next
  start creates a new sandbox that mounts the same drive. A drive is attached to
  an existing machine with `Sandbox.update({ mounts })` while it is stopped, which
  takes effect when it resumes; a machine that is running when the server is
  upgraded picks up its drive on its next start.

The first boot with a drive migrates the home. If the drive has no
`.orchard-drive` marker and the old home at `/vercel/sandbox/orchard` exists, the
bootstrap copies it onto the drive with `rsync -aH` (or `cp -a`), keeping owners
and modes, and only then writes the marker. The old copy is left where it is. If
the copy fails, the machine keeps using the old home and the copy is retried on
the next start. A drive that is not mounted (for example because the plan has no
drives) leaves the machine on its old home.

Only deleting a machine deletes its drive: after the sandbox is gone, the delete
step removes `orchard-<machine id>` (retrying while Vercel still reports it
attached) and only then removes the machine's row. Stopping, starting, provider
timeouts, failed starts and forks never delete a drive. Vercel lets a drive be
deleted while a stopped sandbox still mounts it, so never delete `orchard-*`
drives by hand unless the machine is gone.

If the team cannot create drives (`402` or `403` from Vercel), the runner logs
once, keeps new machines on snapshots that never expire, and tries drives again an
hour later. A machine that already has a drive never falls back; it fails to start
until the drive is reachable. Setting `vercelDriveGiB` to 0 turns drives off for
new machines the same way.

Forking a machine with a drive needs Vercel **drive forks**, which are in private
beta and not on every plan. The runner checks once every ten minutes; without
them the fork option is hidden and a fork request fails with "Forking needs
Vercel drive forks, which this team's plan doesn't have". A machine without a
drive forks from its snapshot and gets a fresh drive of its own.

Measured against the live API with the universal image and 2 vCPUs: creating a
machine takes about 3 seconds and the first boot about 12 to 18 more, because the
image already ships Node.js, Claude Code, Codex and opencode. Stopping takes about
7 seconds, resuming about 4 seconds plus a 2 to 3 second boot, and a fork about 4
seconds.

To check a Vercel setup end to end, run `pnpm --filter server live:sandbox-vercel`
with the three `SANDBOX_VERCEL_*` variables set. It drives the runner against the
real API (create, credential brokering, exec, the protected ports, a terminal, SSH
through the bridge, stop and resume, fork, the machine drive surviving the loss
of its sandbox, a snapshot-only machine migrating onto a drive, delete) and
deletes every machine and drive it made. `--cleanup` removes any `orchard-live-*`
sandboxes and drives left in the project.

### How credentials reach a Vercel machine

- **GitHub.** The host's GitHub token is never placed inside the machine. It is
  set as a Vercel network policy that adds the `Authorization` header at Vercel's
  egress proxy. On `github.com` the proxy only swaps in the token when a request
  carries the machine's placeholder credential (the one git's credential helper
  holds), so a guest who pushes with their own token keeps their own identity, and
  requests with no credential pass through untouched. On `api.github.com` the token
  is added to every request, so `gh` and `curl` in any terminal on the machine act
  as the host. Updating the token updates the policy, also while the machine is
  stopped, without waking it.
- **Claude and OpenAI.** Passed as environment variables to the bootstrap command
  on each start. They are never given to `Sandbox.create`, so they do not appear in
  Vercel's sandbox configuration.
- **Files.** `authorized_keys`, the opencode credentials and attached project
  env files are written to a staging directory and moved into `/orchard-init`
  with mode 600 for anything secret.

### Public ports

Every exposed port has a public Vercel URL.

- **4096**, the agent server, requires HTTP Basic auth with a per-machine
  password.
- **2222**, the SSH bridge, requires a per-machine bearer token. Behind it, sshd
  still requires the host's SSH key.
- **Preview ports** are not authenticated at all. Users see them labelled
  **Public**.

The password and token are `HMAC-SHA256(SECRETS_ENCRYPTION_KEY,
"orchard-sandbox:<purpose>:<machine id>[:<epoch>]")`. They are derived on demand
and never stored. Each machine has a secret epoch (`sandboxes.secret_epoch`,
starting at 0, which leaves the epoch out of the input) that goes up by one when a
guest is removed or made read-only. Orchard then resyncs the machine: the new
password and token are written into it and the agent server restarts with the new
password, so a removed guest who copied the old ones can no longer use the public
ports. The bridge reads its token file on every connection. Orchard always signs
its own requests with the current epoch; while the agent server is still
restarting, the API answers `503` with `code: "agent_restarting"`. Rotating
`SECRETS_ENCRYPTION_KEY` also changes them; restart Vercel machines afterwards so
they pick up the new values.

### Snapshots contain secrets

A persistent snapshot is the whole machine, and the drive holds the `dev` user's
files. Together they include the host's Claude token (in the agent's
configuration), the agent server password, the bridge token, the `dev` user's
files and any attached project env files. Anyone with access to the Vercel
project's sandboxes, snapshots and drives can read them. Give Vercel team access
on that basis.

## Previews

Kubernetes previews are served by the Orchard server itself on a domain of their
own. Users open `https://<port>-<machine>.<previewDomain>/`.

1. **Pick a preview domain.** It must be on a different site (registrable
   domain) from Orchard's cookie domain, Orchard's own hostname and every
   hostname in `PLATFORM_ORIGINS`, because previews run code that users wrote and
   a same-site page could set cookies for Orchard. `preview.example.com` next to
   `app.example.com` is refused; `orchard-preview.dev` for an Orchard on
   `example.com` is the intended shape. Orchard checks this when the setting is
   saved, and switches previews off with a log line if the environment later
   makes it unsafe.
2. **Wildcard DNS.** Point `*.<previewDomain>` at your ingress.
3. **Route and certificate.** With `sandbox.runners.previewDomain` set, the chart
   renders a Traefik IngressRoute for `<port>-<machine>.<previewDomain>` on
   `ingress.entryPoints`, sending every path to the `server` service, and a
   cert-manager Certificate for `*.<previewDomain>`:

   | Value                             | Default                          | Notes                                                                                                                                          |
   | --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
   | `sandbox.previews.route`          | `true`                           | `false` to bring your own route.                                                                                                               |
   | `sandbox.previews.tls.secretName` | `<release>-sandbox-previews-tls` | The Secret Traefik terminates with.                                                                                                            |
   | `sandbox.previews.tls.issuerRef`  | `certificates.issuer`            | Wildcards need a DNS-01 issuer. With `certificates.enabled` false and no issuer, no Certificate is rendered and the Secret must already exist. |

   Without the chart, the equivalent Traefik route is:

   ```yaml
   apiVersion: traefik.io/v1alpha1
   kind: IngressRoute
   metadata:
     name: orchard-sandbox-previews
     namespace: orchard
   spec:
     entryPoints: [websecure]
     routes:
       - kind: Rule
         match: HostRegexp(`^[0-9]+-[0-9a-f]{8}\.preview\.example\.com$`)
         services:
           - name: server
             port: 3001
     tls:
       secretName: wildcard-preview-tls
   ```

4. **Set the domain** in `previewDomain` (`SANDBOX_PREVIEW_DOMAIN`). The Kubernetes
   runner then reports `previews: proxy` in its capabilities (`none` without a
   usable domain).

Preview tickets and cookies are signed with keys derived from `JWT_SECRET`, and a
ticket can be used once, tracked in Redis (or memory on a single replica). The
NetworkPolicy already lets the server reach the preview ports, and the
per-machine policy above covers ports a repository declares.

Every other WebSocket handler on the server (terminals, pod shells, SSH and the
live connection) steps aside for requests addressed to a preview host, so an app
running in a machine cannot reach them through its preview address.

Vercel previews need none of this: they use Vercel's public URLs.

## Configuration reference

### Admin settings

These live at **Instance admin → Configuration** and can each be pinned with the
environment variable shown, which locks the field.

**Sandbox runners**

| Field                  | Variable                            | Notes                                                                 |
| ---------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `kubernetesEnabled`    | `SANDBOX_RUNNER_KUBERNETES_ENABLED` | Default on.                                                           |
| `vercelEnabled`        | `SANDBOX_RUNNER_VERCEL_ENABLED`     | Default off.                                                          |
| `defaultRunner`        | `SANDBOX_DEFAULT_RUNNER`            | `kubernetes` or `vercel`. Falls back to the first available runner.   |
| `vercelToken`          | `SANDBOX_VERCEL_TOKEN`              | Secret.                                                               |
| `vercelTeamId`         | `SANDBOX_VERCEL_TEAM_ID`            |                                                                       |
| `vercelProjectId`      | `SANDBOX_VERCEL_PROJECT_ID`         |                                                                       |
| `vercelImage`          | `SANDBOX_VERCEL_IMAGE`              |                                                                       |
| `vercelVcpus`          | `SANDBOX_VERCEL_VCPUS`              | 1 to 8.                                                               |
| `vercelTimeoutMinutes` | `SANDBOX_VERCEL_TIMEOUT_MINUTES`    | 1 to 1440.                                                            |
| `vercelDriveGiB`       | `SANDBOX_VERCEL_DRIVE_GIB`          | 0 to 16384. Empty means 50; 0 turns drives off.                       |
| `bridgeBinaryUrl`      | `SANDBOX_BRIDGE_BINARY_URL`         | `https://` only.                                                      |
| `bridgeBinarySha256`   | `SANDBOX_BRIDGE_BINARY_SHA256`      | 64 hex characters. Required with `bridgeBinaryUrl`.                   |
| `previewDomain`        | `SANDBOX_PREVIEW_DOMAIN`            | A bare domain on a different site from Orchard and its cookie domain. |

Switching a runner off stops new machines on it. Existing machines on that
runner keep working, so you can retire a runner without stranding anyone.

**Slack app**

| Field           | Variable               | Notes                                                      |
| --------------- | ---------------------- | ---------------------------------------------------------- |
| `signingSecret` | `SLACK_SIGNING_SECRET` | Required. Secret.                                          |
| `botToken`      | `SLACK_BOT_TOKEN`      | Required. Secret. Must start with `xoxb-`.                 |
| `appId`         | `SLACK_APP_ID`         | Optional. When set, events from any other app are ignored. |

**Linear**

| Field           | Variable                | Notes             |
| --------------- | ----------------------- | ----------------- |
| `webhookSecret` | `LINEAR_WEBHOOK_SECRET` | Required. Secret. |

### Environment only

| Variable                       | Default                   | What it does                                                                                       |
| ------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `SANDBOX_ENABLED`              |                           | Pins the Greenhouse switch, see [Turning it on](#turning-it-on).                                   |
| `SANDBOX_ENABLED_DEFAULT`      |                           | Where the switch starts when it is not pinned and no admin has set it. Does not lock it.           |
| `SANDBOX_NAMESPACE`            | `orchard-sandboxes`       | Namespace for Kubernetes machines.                                                                 |
| `SANDBOX_IMAGE`                | `debian:bookworm`         | Image for new Kubernetes machines.                                                                 |
| `SANDBOX_RUNTIME_CLASS`        |                           | RuntimeClass, usually `kata`. Empty runs on the default runtime.                                   |
| `SANDBOX_HOME_MODE`            | `auto`                    | `block`, `filesystem`, or `auto` (block when a RuntimeClass is set).                               |
| `SANDBOX_STORAGE_CLASS`        | cluster default           | StorageClass for home volumes.                                                                     |
| `SANDBOX_DISK_SIZE`            | `10Gi`                    | Home volume size for new machines.                                                                 |
| `SANDBOX_CPU_LIMIT`            | `2`                       | CPU limit per Kubernetes machine.                                                                  |
| `SANDBOX_MEMORY_LIMIT`         | `4Gi`                     | Memory limit per Kubernetes machine. Keep at least `1Gi` under Kata.                               |
| `SANDBOX_TUNNEL_MODE`          |                           | `portforward` for servers outside the cluster.                                                     |
| `SANDBOX_MAX_PER_USER`         | `1`                       | Default machine cap per person. Admins override it per user; superadmins are uncapped.             |
| `SANDBOX_IDLE_TIMEOUT_MINUTES` | `60`                      | Stop running machines idle this long. `0` never.                                                   |
| `SANDBOX_MAX_LIFETIME_HOURS`   | `168`                     | Stop machines running this long since their last start. `0` never.                                 |
| `SANDBOX_MCP_URL`              | derived from the MCP host | The MCP endpoint configured into each machine's agent. Vercel machines only use an `https://` URL. |
| `ORCHARD_SERVER_NAMESPACE`     | `orchard`                 | The server's namespace, used in the NetworkPolicy.                                                 |

Everything here is also in the generated [configuration reference](/reference/configuration/).

### Helm values

`sandbox.*` in the chart maps onto the variables above:

| Value                                                                            | Variable                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `sandbox.install`                                                                | the namespace, quota, NetworkPolicy, RBAC and `SANDBOX_*` settings |
| `sandbox.enabled`                                                                | `SANDBOX_ENABLED_DEFAULT=true`; also `install` unless that is set  |
| `sandbox.lockEnabled`                                                            | `SANDBOX_ENABLED` and `PUBLIC_SANDBOX_ENABLED`                     |
| `sandbox.namespace`                                                              | `SANDBOX_NAMESPACE`                                                |
| `sandbox.image`                                                                  | `SANDBOX_IMAGE`                                                    |
| `sandbox.runtimeClassName`                                                       | `SANDBOX_RUNTIME_CLASS`                                            |
| `sandbox.idleTimeoutMinutes`                                                     | `SANDBOX_IDLE_TIMEOUT_MINUTES`                                     |
| `sandbox.maxLifetimeHours`                                                       | `SANDBOX_MAX_LIFETIME_HOURS`                                       |
| `sandbox.maxPerUserDefault`                                                      | `SANDBOX_MAX_PER_USER`                                             |
| `sandbox.storageClass`, `diskSize`, `cpuLimit`, `memoryLimit`                    | the matching `SANDBOX_*` variables                                 |
| `sandbox.tunnelMode`, `homeMode`                                                 | `SANDBOX_TUNNEL_MODE`, `SANDBOX_HOME_MODE`                         |
| `sandbox.quota.*`                                                                | the namespace ResourceQuota                                        |
| `sandbox.runners.default`                                                        | `SANDBOX_DEFAULT_RUNNER`                                           |
| `sandbox.runners.kubernetes.enabled`                                             | `SANDBOX_RUNNER_KUBERNETES_ENABLED`                                |
| `sandbox.runners.vercel.enabled`                                                 | `SANDBOX_RUNNER_VERCEL_ENABLED`                                    |
| `sandbox.runners.vercel.tokenSecret`                                             | `SANDBOX_VERCEL_TOKEN`, from a Secret you create                   |
| `sandbox.runners.vercel.teamId`, `projectId`, `image`, `vcpus`, `timeoutMinutes` | the matching `SANDBOX_VERCEL_*` variables                          |
| `sandbox.runners.bridgeBinaryUrl`                                                | `SANDBOX_BRIDGE_BINARY_URL`                                        |
| `sandbox.runners.bridgeBinarySha256`                                             | `SANDBOX_BRIDGE_BINARY_SHA256`                                     |
| `sandbox.runners.previewDomain`                                                  | `SANDBOX_PREVIEW_DOMAIN`, plus the preview route and certificate   |
| `sandbox.previews.*`                                                             | the preview route and certificate, see [Previews](#previews)       |

Anything under `sandbox.runners` left empty (or `null` for the booleans) renders
no variable, so the field stays editable in the admin UI. The Vercel token is
always read from a Secret:

```yaml
sandbox:
  enabled: true
  runtimeClassName: kata
  runners:
    default: kubernetes
    vercel:
      enabled: true
      tokenSecret: { name: orchard-vercel, key: token }
      teamId: team_abc123
      projectId: prj_abc123
    previewDomain: orchard-preview.dev
```

```bash
kubectl -n orchard create secret generic orchard-vercel --from-literal=token=...
```

## Integrations

### GitHub issues

`/greenhouse` comments on issues arrive through the GitHub App Orchard already
uses for deployments, on the same webhook URL. The App needs:

1. **Repository permissions → Issues: Read and write**, to read the issue and
   reply to the comment.
2. **Subscribe to events → Issue comment**.

An App created from **Instance admin → GitHub App** asks for both already. An App
registered before that, or by hand, needs both changed in its settings on GitHub,
and each installation then has to accept the new permission before comments from
its repositories arrive.

People must link their GitHub account in Orchard (**User settings → GitHub and
Tailscale**) for their comments to be acted on.

### Slack

Create a Slack app from this manifest, replacing the host:

```yaml
display_information:
  name: Greenhouse
  description: Start Orchard Greenhouse sessions from Slack
features:
  bot_user:
    display_name: Greenhouse
    always_online: false
  slash_commands:
    - command: /greenhouse
      url: https://orchard.example.com/apiv1/integrations/slack/commands
      description: Start a Greenhouse session, or link your Orchard account
      usage_hint: '[what to do] | link | unlink | help'
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - commands
settings:
  event_subscriptions:
    request_url: https://orchard.example.com/apiv1/integrations/slack/events
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Install it to the workspace, then set in **Slack app**:

- `signingSecret`: **Basic Information → Signing Secret**.
- `botToken`: **OAuth & Permissions → Bot User OAuth Token** (`xoxb-...`).
- `appId`: optional, **Basic Information → App ID**.

Slack's URL verification for the events URL succeeds once the signing secret is
saved. People then run `/greenhouse link` once each; accounts are never matched
by email.

### Linear

In Linear, under **Settings → API → Webhooks**, create a webhook:

- **URL:** `https://orchard.example.com/apiv1/integrations/linear/webhook`
- **Events:** Comments.

Copy its signing secret into **Linear → webhookSecret**. Each person who wants to
use `/greenhouse` on Linear connects their own personal API key under
**User settings**; that key both identifies them and posts the replies.

### Verification and limits

| Endpoint                             | Verified by                                           | Rate limit     |
| ------------------------------------ | ----------------------------------------------------- | -------------- |
| `/apiv1/github/app/webhook`          | The GitHub App webhook secret                         | as for deploys |
| `/apiv1/integrations/slack/commands` | Slack signing secret, timestamp within 5 minutes      | 120 a minute   |
| `/apiv1/integrations/slack/events`   | Slack signing secret, timestamp within 5 minutes      | 300 a minute   |
| `/apiv1/integrations/linear/webhook` | Linear signature, `webhookTimestamp` within 5 minutes | 120 a minute   |

Every delivery is recorded and a repeat is ignored, so retries never start a
second session. Each person can start at most five sessions a minute from
integrations.

## Security model

### Roles

The host owns a machine; guests and read-only guests are invited by the host from
the same organization; org admins of the machine's organization get its lifecycle
only: they see it in lists (name, status, runner, owner, timestamps, never the
setup script) and can start, stop, delete it and retry failed changes, but not
read its sessions, transcripts, comments, files, diffs, ports, previews, members,
terminals, the live connection or the agent server. An org admin who is also
invited gets the invited role on top of the lifecycle. Superadmins have host
access as a break-glass. A host who leaves the
organization loses the machine with it; org admins keep its lifecycle. The full
matrix is in [Sharing](/greenhouse/sharing/#what-each-role-can-do).

Every REST route checks the minimum role it needs on the server. The live
connection checks the role for every message type and drops writes from
read-only guests, including collaborative edits; a collaborative document only
accepts plain text edits to its own file, so a guest cannot grow it with hidden
data. Terminal, SSH and live connections re-check access every 15 seconds and
when membership changes, and disconnect anyone who lost it. Every WebSocket
upgrade that is authenticated by the session cookie (live, terminal, pod exec,
SSH) must come from one of Orchard's own origins; the CLI authenticates with a
bearer token instead and sends no cookie. Upgrades on a preview host are only
ever handled by the preview proxy.

API tokens restricted to specific projects cannot use Greenhouse or manage linked
Slack and Linear accounts, and sessions scoped to one organization only reach
machines in it. Both hold for REST, the live connection, terminals and the SSH
tunnel, and for the hop between replicas when a terminal lives on another
replica.

Reads of files and diffs, and file operations, resolve the path inside the
machine and refuse anything outside the session worktree or the repository, or
directly under a dot directory of the home directory, symlinks included. Read-only
guests and share links therefore cannot reach `~/.git-credentials`,
`~/.config/orchard` or `~/.claude` through a link planted in a repository. The
worktrees folder itself cannot be renamed or deleted from the file tree.

Everything the agent server returns through Orchard is served as JSON, an event
stream or plain text with `nosniff` and a sandboxing Content-Security-Policy, so a
machine can never make the Orchard origin render a page.

### Disclosure instead of pretending

A guest on a machine runs the host's agent, on the host's Claude subscription,
with access to the host's files. Greenhouse does not try to engineer that away. It
tells both sides, in the share sheet and in a notice every guest must
acknowledge, exactly what sharing gives. The text is quoted in
[What sharing gives your guests](/greenhouse/sharing/#what-sharing-gives-your-guests).

### Where tokens live

| Token                                     | Stored                                                                                                                                                           | Reaches a machine as                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude and OpenAI tokens                  | Encrypted in Postgres (AES-256-GCM)                                                                                                                              | The machine's Secret (Kubernetes) or bootstrap environment (Vercel)                                                                                     |
| The host's GitHub token, for the agent    | Encrypted in Postgres                                                                                                                                            | The machine's Secret (Kubernetes); an egress header, never inside the machine (Vercel)                                                                  |
| A person's GitHub token, for their pushes | Encrypted in Postgres                                                                                                                                            | The environment of the one git command they run, or of their own terminal while it is open; the credential helper only hands it to `https://github.com` |
| Agent server password, SSH bridge token   | Not stored; derived with HMAC from `SECRETS_ENCRYPTION_KEY` and the machine's secret epoch                                                                       | Files in `/orchard-init`, mode 600; the agent server requires the password on both runners                                                              |
| Share link tokens                         | SHA-256 hash only; links carry them after `#`, the API reads them from `X-Orchard-Share-Token`                                                                   | Never                                                                                                                                                   |
| Slack link tokens                         | SHA-256 hash only, single use, 10 minutes                                                                                                                        | Never                                                                                                                                                   |
| Linear API keys                           | Encrypted in Postgres                                                                                                                                            | Never                                                                                                                                                   |
| The agent's Orchard MCP token             | A 60-day token on a per-machine `sandbox-mcp:<organization>:<machine>` session of the host, confined to the machine's organization and refused superadmin routes | The agent's MCP configuration                                                                                                                           |

And where they never are:

- **The apply queue.** Queue items carry only machine ids. The Secret is built
  from the encrypted credentials when the item is applied.
- **The mirror.** Secrets in the sandbox namespace are mirrored with their `data`
  removed. Whether a Secret is current is read from an
  `orchard.my/spec-hash` annotation, an HMAC of its contents.
- **Vercel's sandbox configuration.** Tokens are never passed to
  `Sandbox.create`.
- **Command lines on the way in.** File contents and tokens reach a machine on
  stdin, never as process arguments, so they do not show up in process listings.
  Staged stdin on Vercel is deleted before the command starts. Inside the
  machine, Orchard's own calls to the agent server read its password from the
  same file the server uses.
- **Logs, audit metadata and live events.** Datadog traces and error reports
  replace the token in the older `/share/sandbox/<token>` URLs with `[redacted]`,
  and git output shown in the browser has credentials in remote URLs masked.
- **Project variables that would steer tools.** Attached project env files skip
  names such as `GIT_*`, `LD_*`, `NODE_OPTIONS`, `PROMPT_COMMAND`, proxy and CA
  bundle variables and `ANTHROPIC_*`, so an editor of an attached project cannot
  redirect pushes, run code in shells or point the agent elsewhere.
- **Preview builds.** A preview deploy copies the source deployment's plain
  variables only; secret ones are listed as skipped and have to be set on the
  preview environment.

When a guest is removed or made read-only, their terminals in the machine are
ended, the machine's MCP session is revoked and its secret epoch goes up. The
machine's Secret is resynced with a new MCP token, which the agent picks up when
the machine next starts (until then its Orchard tools are unavailable), and with a
new agent server password and bridge token, which take effect right away: the
agent server is restarted with the new password, interrupting any agent run in
progress.

The residual risks are deliberate and documented:

- Guests act through the host's agent and the host's machine. Everyone with a
  terminal runs as the same user with `sudo`, so a guest can read every credential
  in the machine, including the agent's MCP token (which acts as the host in the
  machine's organization) and the agent server password.
- The host, other guests and the agent can read a guest's GitHub token from the
  guest's terminal environment while it is open, and could intercept a push by
  reconfiguring git inside the machine.
- Vercel snapshots and drives, and therefore forks, contain the machine's secrets, and on
  Kubernetes the home volume holds the agent's GitHub credential.
- Issue text reaches the agent fenced as untrusted data, and outsider-written
  issues need the host to start them, but prompt injection is reduced, not
  eliminated.
- Removing a guest does not undo what they already did in the machine. Rebuild
  the machine if you no longer trust someone who had access.

### Previews

Preview tickets are signed, single use and valid for 60 seconds. The cookie they
are exchanged for is `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to the one
preview host and valid for 12 hours, and each request re-checks the person's
access to the machine (cached for up to 15 seconds). Orchard's own cookies and
authorization headers are stripped before a request reaches the machine, cookies
the app sets cannot name a parent domain, and cross-site requests are refused.
The server only ever connects to the allow-listed preview ports of the machine
named in the host; there is no client-supplied target. A preview WebSocket that
is already open stays open after its user loses access until either side closes
it. On Vercel, previews are the machine's public URL and need no sign-in.

### Audit log

Greenhouse records `sandbox.create`, `.start`, `.stop`, `.delete`,
`.idle_stop`, `.lifetime_stop`, `.fork`, `.keys.update`, `.credentials.update`,
`.apply.retry`, `.ssh.connect`, `.terminal.open`, `.terminal.reattach`, `.terminal.denied`,
`.member.add`, `.member.update`, `.member.remove`, `.member.leave`,
`.share_link.create`, `.share_link.revoke`, `.share_link.use`,
`.project.attached`, `.project.detached`, `.session.preview.deployed`,
`.session.preview.redeployed`, `.session.preview.removed` and
`.session.started_from`.
