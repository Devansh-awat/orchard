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

The chart sets `SANDBOX_ENABLED=true` when `sandbox.enabled` is true, which also
renders the namespace, NetworkPolicy, RBAC and `SANDBOX_*` settings the
Kubernetes runner needs. With `sandbox.enabled` false none of that is rendered,
the admin switch decides, and only `sandbox.runners` is passed through, which
suits a Vercel-only setup.

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
   NetworkPolicy and the RBAC the server needs, when `sandbox.enabled` is true.
   The server also applies the namespace and NetworkPolicy itself through the
   apply queue whenever it becomes leader, so they stay correct.
3. **Kata Containers** (optional, strongly recommended). With a Kata
   RuntimeClass each machine is a lightweight VM. Its home volume is attached as
   a raw block device and formatted inside the VM, which is fast for
   `node_modules`-heavy work and needs a privileged container inside the VM.
   Without Kata, leave `runtimeClassName` empty: machines run on `runc` with an
   ordinary filesystem volume and no privileges.
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
| `VolumeSnapshot`          | `sbx-<id>-fork`         | Only while forking.                                                                     |

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

1. **Pick a preview domain.** It must not be Orchard's cookie domain, Orchard's
   own hostname, a hostname in `PLATFORM_ORIGINS`, or a parent or child of any of
   them, because previews run code that users wrote. Orchard checks this when the
   setting is saved, and switches previews off with a log line if the environment
   later makes it unsafe. A separate registrable domain (for example
   `orchard-preview.dev` for an Orchard on `example.com`) is the safest choice.
2. **Wildcard DNS.** Point `*.<previewDomain>` at your ingress.
3. **Wildcard TLS.** A certificate for `*.<previewDomain>`, typically from
   cert-manager with a DNS-01 issuer.
4. **Route every path to the server.** The chart does not create this route. With
   Traefik:

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

5. **Set the domain** in `previewDomain` (`SANDBOX_PREVIEW_DOMAIN`).

Preview tickets and cookies are signed with keys derived from `JWT_SECRET`, and a
ticket can be used once, tracked in Redis (or memory on a single replica). The
NetworkPolicy already lets the server reach the preview ports.

Vercel previews need none of this: they use Vercel's public URLs.

## Configuration reference

### Admin settings

These live at **Instance admin → Configuration** and can each be pinned with the
environment variable shown, which locks the field.

**Sandbox runners**

| Field                  | Variable                            | Notes                                                               |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `kubernetesEnabled`    | `SANDBOX_RUNNER_KUBERNETES_ENABLED` | Default on.                                                         |
| `vercelEnabled`        | `SANDBOX_RUNNER_VERCEL_ENABLED`     | Default off.                                                        |
| `defaultRunner`        | `SANDBOX_DEFAULT_RUNNER`            | `kubernetes` or `vercel`. Falls back to the first available runner. |
| `vercelToken`          | `SANDBOX_VERCEL_TOKEN`              | Secret.                                                             |
| `vercelTeamId`         | `SANDBOX_VERCEL_TEAM_ID`            |                                                                     |
| `vercelProjectId`      | `SANDBOX_VERCEL_PROJECT_ID`         |                                                                     |
| `vercelImage`          | `SANDBOX_VERCEL_IMAGE`              |                                                                     |
| `vercelVcpus`          | `SANDBOX_VERCEL_VCPUS`              | 1 to 8.                                                             |
| `vercelTimeoutMinutes` | `SANDBOX_VERCEL_TIMEOUT_MINUTES`    | 1 to 1440.                                                          |
| `bridgeBinaryUrl`      | `SANDBOX_BRIDGE_BINARY_URL`         | `https://` only.                                                    |
| `previewDomain`        | `SANDBOX_PREVIEW_DOMAIN`            | A bare domain; validated against the cookie domain.                 |

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

| Value                                                                            | Variable                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `sandbox.enabled`                                                                | `SANDBOX_ENABLED=true`, plus the namespace, quota, NetworkPolicy and RBAC |
| `sandbox.namespace`                                                              | `SANDBOX_NAMESPACE`                                                       |
| `sandbox.image`                                                                  | `SANDBOX_IMAGE`                                                           |
| `sandbox.runtimeClassName`                                                       | `SANDBOX_RUNTIME_CLASS`                                                   |
| `sandbox.idleTimeoutMinutes`                                                     | `SANDBOX_IDLE_TIMEOUT_MINUTES`                                            |
| `sandbox.maxLifetimeHours`                                                       | `SANDBOX_MAX_LIFETIME_HOURS`                                              |
| `sandbox.maxPerUserDefault`                                                      | `SANDBOX_MAX_PER_USER`                                                    |
| `sandbox.storageClass`, `diskSize`, `cpuLimit`, `memoryLimit`                    | the matching `SANDBOX_*` variables                                        |
| `sandbox.tunnelMode`, `homeMode`                                                 | `SANDBOX_TUNNEL_MODE`, `SANDBOX_HOME_MODE`                                |
| `sandbox.quota.*`                                                                | the namespace ResourceQuota                                               |
| `sandbox.runners.default`                                                        | `SANDBOX_DEFAULT_RUNNER`                                                  |
| `sandbox.runners.kubernetes.enabled`                                             | `SANDBOX_RUNNER_KUBERNETES_ENABLED`                                       |
| `sandbox.runners.vercel.enabled`                                                 | `SANDBOX_RUNNER_VERCEL_ENABLED`                                           |
| `sandbox.runners.vercel.tokenSecret`                                             | `SANDBOX_VERCEL_TOKEN`, from a Secret you create                          |
| `sandbox.runners.vercel.teamId`, `projectId`, `image`, `vcpus`, `timeoutMinutes` | the matching `SANDBOX_VERCEL_*` variables                                 |
| `sandbox.runners.bridgeBinaryUrl`                                                | `SANDBOX_BRIDGE_BINARY_URL`                                               |
| `sandbox.runners.previewDomain`                                                  | `SANDBOX_PREVIEW_DOMAIN`                                                  |

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
uses for deployments, on the same webhook URL. The App needs two things the
default registration does not ask for:

1. **Repository permissions → Issues: Read and write**, to read the issue and
   reply to the comment.
2. **Subscribe to events → Issue comment**.

Change both in the App's settings on GitHub. Each installation then has to accept
the new permission before comments from its repositories arrive.

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
the same organization; org admins can see a machine and start, stop or delete it;
superadmins have host access. The full matrix is in
[Sharing](/greenhouse/sharing/#what-each-role-can-do).

Every REST route checks the minimum role it needs on the server. The live
connection checks the role for every message
type and drops writes from read-only guests, including collaborative edits.
Terminal, SSH and live connections re-check access every 15 seconds and when
membership changes, and disconnect anyone who lost it. WebSocket upgrades check
the `Origin` against Orchard's own origins.

API tokens restricted to specific projects cannot use Greenhouse, and sessions
scoped to one organization only reach machines in it.

### Disclosure instead of pretending

A guest on a machine runs the host's agent, on the host's Claude subscription,
with access to the host's files. Greenhouse does not try to engineer that away. It
tells both sides, in the share sheet and in a notice every guest must
acknowledge, exactly what sharing gives. The text is quoted in
[What sharing gives your guests](/greenhouse/sharing/#what-sharing-gives-your-guests).

### Where tokens live

| Token                                     | Stored                                                          | Reaches a machine as                                                                   |
| ----------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Claude and OpenAI tokens                  | Encrypted in Postgres (AES-256-GCM)                             | The machine's Secret (Kubernetes) or bootstrap environment (Vercel)                    |
| The host's GitHub token, for the agent    | Encrypted in Postgres                                           | The machine's Secret (Kubernetes); an egress header, never inside the machine (Vercel) |
| A person's GitHub token, for their pushes | Encrypted in Postgres                                           | The environment of the one git command they run, never on disk                         |
| Agent server password, SSH bridge token   | Not stored; derived with HMAC from `SECRETS_ENCRYPTION_KEY`     | Files in `/orchard-init`, mode 600                                                     |
| Share link tokens                         | SHA-256 hash only                                               | Never                                                                                  |
| Slack link tokens                         | SHA-256 hash only, single use, 10 minutes                       | Never                                                                                  |
| Linear API keys                           | Encrypted in Postgres                                           | Never                                                                                  |
| The agent's Orchard MCP token             | A 60-day token on a dedicated `sandbox-mcp` session of the host | The agent's MCP configuration                                                          |

And where they never are:

- **The apply queue.** Queue items carry only machine ids. The Secret is built
  from the encrypted credentials when the item is applied.
- **The mirror.** Secrets in the sandbox namespace are mirrored with their `data`
  removed. Whether a Secret is current is read from an
  `orchard.my/spec-hash` annotation, an HMAC of its contents.
- **Vercel's sandbox configuration.** Tokens are never passed to
  `Sandbox.create`.
- **Command lines.** File contents and tokens reach a machine on stdin, never as
  process arguments, so they do not show up in process listings.
- **Logs, audit metadata and live events.**

The residual risks are deliberate and documented: guests act through the host's
agent and can read the host's machine, Vercel snapshots contain the machine's
secrets, and on Kubernetes the home volume holds the agent's GitHub credential.

### Previews

Preview tickets are signed, single use and valid for 60 seconds. The cookie they
are exchanged for is `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to the one
preview host and valid for 12 hours, and each request re-checks the person's
access to the machine. Orchard's own cookies and authorization headers are
stripped before a request reaches the machine, cookies the app sets cannot name
a parent domain, and cross-site requests are refused. The server only ever
connects to the allow-listed preview ports of the machine named in the host;
there is no client-supplied target.

### Audit log

Greenhouse records `sandbox.create`, `.start`, `.stop`, `.delete`,
`.idle_stop`, `.lifetime_stop`, `.fork`, `.keys.update`, `.credentials.update`,
`.ssh.connect`, `.terminal.open`, `.terminal.reattach`, `.terminal.denied`,
`.member.add`, `.member.update`, `.member.remove`, `.member.leave`,
`.share_link.create`, `.share_link.revoke`, `.share_link.use`,
`.project.attached`, `.project.detached`, `.session.preview.deployed`,
`.session.preview.redeployed`, `.session.preview.removed` and
`.session.started_from`.
