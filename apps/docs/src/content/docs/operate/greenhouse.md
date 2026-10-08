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

Greenhouse is a switch at **Instance admin → Configuration**, stored in the
database like the MCP switch.

| `SANDBOX_ENABLED` | Effect                                                                           |
| ----------------- | -------------------------------------------------------------------------------- |
| unset             | The admin switch decides. It starts **off** in production and on in development. |
| `true`            | On, and the switch is locked on.                                                 |
| `false`           | Off, and the switch is locked off.                                               |

`SANDBOX_ENABLED_DEFAULT` (`true` or `false`) changes where the switch starts
without locking it: admins can still flip it, and their choice wins from then on.

In the chart, installing Greenhouse and switching it on are separate:

| Value                 | Default           | What it does                                                                                                                                       |
| --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.install`     | follows `enabled` | Renders the namespace, quota, NetworkPolicy, RBAC and `SANDBOX_*` settings the Kubernetes runner needs.                                            |
| `sandbox.enabled`     | `false`           | Starts the admin switch on (`SANDBOX_ENABLED_DEFAULT=true`) and, unless `install` is set, installs everything above. Admins can still turn it off. |
| `sandbox.lockEnabled` | `null`            | `true` or `false` pins the switch (`SANDBOX_ENABLED`, and `PUBLIC_SANDBOX_ENABLED` for the dashboard). `null` leaves it to the admin.              |

To ship the plumbing and let an admin turn Greenhouse on later, set
`sandbox.install: true` and leave `enabled` false. With nothing installed only
`sandbox.runners` is passed through, which suits a Vercel-only setup.

Charts before this change locked the switch on whenever `sandbox.enabled` was
true. After upgrading, the switch starts on but is editable; set
`sandbox.lockEnabled: true` to keep the old behaviour.

Off means the API, terminals, SSH, live connections and previews all answer 404,
and the integrations refuse to start sessions. Machines that exist are left
alone, not stopped.

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
| `bridgeBinaryUrl`      | the release matching the server | An `https://` URL of the Linux amd64 `orchard` CLI tarball, run in each machine as the SSH bridge. Set it for air-gapped mirrors. |
| `bridgeBinarySha256`   | from the release's checksums    | SHA-256 of that tarball. Required when `bridgeBinaryUrl` is set; the runner reports itself unavailable without it.                |

Machines refuse to install a bridge they cannot verify. With the default URL the
server reads the expected SHA-256 from that release's `checksums.txt` on GitHub
(once, then cached) and passes it to the bootstrap as `ORCHARD_BRIDGE_SHA256`;
with your own URL it passes `bridgeBinarySha256`. A download that does not match,
or a start without a checksum, logs a line in the bootstrap output and leaves the
bridge out, so SSH to that machine fails until the checksum is available.

Machines are created as **persistent** sandboxes: stopping one snapshots it and
starting resumes from the snapshot. Each machine exposes port 4096 (the agent
server), 2222 (the SSH bridge) and the seven preview ports.

### How credentials reach a Vercel machine

- **GitHub.** The host's GitHub token is never placed inside the machine. It is
  set as a Vercel network policy that adds the `Authorization` header at Vercel's
  egress proxy for `github.com` and `api.github.com`. Updating the token updates
  the policy.
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
"orchard-sandbox:<purpose>:<machine id>")`. They are derived on demand and never
stored. Rotating `SECRETS_ENCRYPTION_KEY` changes them; restart Vercel machines
afterwards so they pick up the new values.

### Snapshots contain secrets

A persistent snapshot is the whole machine. It includes the host's Claude token
(in the agent's configuration), the agent server password, the bridge token, the
`dev` user's files and any attached project env files. Anyone with access to the
Vercel project's sandboxes and snapshots can read them. Give Vercel team access
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
the same organization; org admins of the machine's organization can see inside
it (sessions, transcripts, files, diffs, read-only terminals and previews) and
start, stop or delete it; superadmins have host access. A host who leaves the
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
| Agent server password, SSH bridge token   | Not stored; derived with HMAC from `SECRETS_ENCRYPTION_KEY`                                                                                                      | Files in `/orchard-init`, mode 600; the agent server requires the password on both runners                                                              |
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
ended and the machine's MCP session is revoked. The machine's Secret is resynced
with a new token, which the agent picks up when the machine next starts; until
then its Orchard tools are unavailable.

The residual risks are deliberate and documented:

- Guests act through the host's agent and the host's machine. Everyone with a
  terminal runs as the same user with `sudo`, so a guest can read every credential
  in the machine, including the agent's MCP token (which acts as the host in the
  machine's organization) and the agent server password.
- The host, other guests and the agent can read a guest's GitHub token from the
  guest's terminal environment while it is open, and could intercept a push by
  reconfiguring git inside the machine.
- Vercel snapshots, and therefore forks, contain the machine's secrets, and on
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
