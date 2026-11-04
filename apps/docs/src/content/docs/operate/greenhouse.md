---
title: Run Greenhouse
description: Install the Greenhouse graft on an Orchard instance, configure the Kubernetes and Vercel runners, previews, and integrations, and review the Greenhouse security model.
sidebar:
  order: 8
---

To run [Greenhouse](/greenhouse/) on your Orchard instance, install the graft and configure where its machines run. This page is for operators.

For the internal design, refer to `docs/ai-sandbox.md` in the repository.

## Prerequisites

- An Orchard instance, and access to the host or to its Helm values.
- For the Kubernetes runner, the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller and its CRDs (`agents.x-k8s.io/v1beta1`). Install them at a pinned release. The Orchard chart does not install them.
- For the Vercel runner, a Vercel access token, team ID, and project ID, and `SECRETS_ENCRYPTION_KEY` set on the server.

## Install the graft

Greenhouse is a [graft](/grafts/overview/), published to the Extension Marketplace.

The graft needs cluster resources for the Kubernetes runner: a namespace, a ResourceQuota, a LimitRange, a NetworkPolicy, RBAC, and `SANDBOX_*` settings. The chart renders them when `sandbox.install` or `sandbox.enabled` is true. Both default to off.

On an installer host, run the following commands:

```sh
sudo orchardctl config set sandbox.enabled true
sudo orchardctl graft add greenhouse --apply
```

For GitOps, set the same values in the chart:

```yaml
sandbox:
  enabled: true
grafts:
  - id: greenhouse
    version: <version>
    digest: sha256:<digest>
```

The [Extension Marketplace page](https://orchard.my/extensions/greenhouse) shows the current version and digest. The rollout works like an Orchard upgrade.

### Control who can use Greenhouse

If the instance has PostHog configured with `POSTHOG_API_KEY`, each person needs the `greenhouse` feature flag. Accounts without the flag get a `404` from the API, and do not see Greenhouse in the sidebar or its MCP tools. The integrations do not start sessions for them.

Without PostHog, there is no flag check. Everyone on the instance can use Greenhouse.

To change how many machines each person can keep, go to **Instance admin** > **Greenhouse**. The default is `sandbox.maxPerUserDefault`. Superadmins have no limit.

### Remove the graft

To remove the graft and keep its data, run the following command:

```sh
sudo orchardctl graft remove greenhouse --apply
```

To also delete its data, run the following command:

```sh
sudo orchardctl graft remove greenhouse --purge --apply
```

`--purge` deletes the `ext_greenhouse` schema and cannot be undone. The command asks you to type the graft's ID.

### Upgrade from a built-in Greenhouse

Earlier Orchard releases shipped Greenhouse as part of Orchard. The first migration of the graft moves the Greenhouse tables from the `public` schema into `ext_greenhouse`, in one transaction. It leaves views with the old names in `public`, so that pods on the previous release keep working during the rollout. It also moves per-person limits from `users.max_sandboxes` to `ext_greenhouse.user_limits`.

Install the graft in the same change that upgrades Orchard. Otherwise, Greenhouse is unavailable until you install it. No data is lost in that time.

## Configure the Kubernetes runner

The runner is on by default.

### Runtime

With a Kata RuntimeClass, each machine is a lightweight VM. Its home volume is a raw block device, formatted inside the VM, and it needs a privileged container inside the VM. The chart default for `sandbox.runtimeClassName` is `kata`.

Without Kata, set `sandbox.runtimeClassName` to empty. Machines then run on `runc` with a filesystem volume and no privileges. A machine whose home volume is already a block device does not start on `runc`. Restore the RuntimeClass, or delete the machine.

### Storage

Set `sandbox.storageClass` for home volumes. The cluster default applies if it is empty.

To allow [forking](/greenhouse/machines/#forking), add a VolumeSnapshotClass whose driver matches that StorageClass's provisioner. Without one, Greenhouse does not offer forking on Kubernetes.

### Image

Machines start from `ghcr.io/hackclub/orchard/sandbox:latest`, built from `infra/images/sandbox`. It includes `sshd`, `git`, `tmux`, Node.js 22, the supported agents and their adapters, and the `orchard` binary.

You can set another image with `sandbox.image`. The bootstrap installs what is missing on `apt` and `dnf` based images, which takes a few minutes. The Kubernetes root filesystem does not persist across a stop, so this repeats on each start.

### Resources

Each machine has these resources, labeled `orchard.my/instance=<id>` and `orchard.my/sandbox-id=<machine id>`:

| Resource                  | Name                    | Notes                                                                                   |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `Sandbox` (agent-sandbox) | `sbx-<id>`              | `operatingMode` is `Running` or `Suspended`.                                            |
| `Secret`                  | `sbx-<id>-auth`         | `authorized_keys`, the bootstrap and setup scripts, agent and GitHub tokens, env files. |
| `PersistentVolumeClaim`   | From the claim template | The home volume, mounted at `/persist`.                                                 |
| `VolumeSnapshot`          | `sbx-<id>-fork`         | Only during a fork.                                                                     |
| `NetworkPolicy`           | `sbx-<id>-previews`     | Only when a repository declares extra preview ports.                                    |

The instance label keeps a second Orchard install on the same cluster from seeing or deleting these resources.

### Network policy

The `sandbox-isolation` policy in the machine namespace allows the following:

- **Ingress:** Orchard server pods only, on TCP 22, 4096, 4097, and the preview ports 3000, 3001, 4173, 5173, 8000, 8080, and 8787.
- **Egress:** kube-dns, and the internet except 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, and 100.64.0.0/10.

The chart renders this policy, and the server applies the same object when it becomes leader. Machine pods run without a service account token.

When a repository declares extra ports in `.orchard/greenhouse.json`, the server adds a `sbx-<id>-previews` policy. It selects only that machine's pod and allows only Orchard server pods.

### Servers outside the cluster

A server outside the cluster cannot reach pod IPs. Set `sandbox.tunnelMode` to `portforward`. The server then reaches SSH, the agent server, and previews through the API server's port-forward.

## Configure the Vercel runner

1. Set `SECRETS_ENCRYPTION_KEY` on the server. The runner does not start without it, because Vercel ports are reachable from the internet and each machine's secrets derive from this key.
2. Go to **Instance admin** > **Configuration** > **Greenhouse runners**.
3. Turn on **Vercel runner**.
4. Enter the **Vercel token**, **Vercel team id**, and **Vercel project id**.

To set the token through Helm, read it from a Secret:

```bash
kubectl -n orchard create secret generic orchard-vercel --from-literal=token=<token>
```

```yaml
sandbox:
  runners:
    vercel:
      enabled: true
      tokenSecret: { name: orchard-vercel, key: token }
      teamId: team_abc123
      projectId: prj_abc123
```

### Persistence

Orchard creates each machine as a persistent sandbox. A stop snapshots the whole root filesystem. Running processes are not kept, so each start re-runs the bootstrap.

- **Snapshots:** Orchard sets `snapshotExpiration: 0` and keeps the last three snapshots.
- **Drive:** Each machine has a [Vercel drive](https://vercel.com/docs/sandbox/concepts/drives) named `orchard-<machine id>`, mounted at `/mnt/orchard-drive`. `/persist` points to it. A new sandbox can mount the same drive if Vercel loses the original.
- **Migration:** A machine without a drive copies its home onto a new drive on its next start. The old copy stays in place. If the copy fails, the machine keeps the old home and retries on the next start.
- **Deletion:** Only deleting a machine deletes its drive.

:::caution
Vercel lets you delete a drive while a stopped sandbox still mounts it. Do not delete `orchard-*` drives unless the machine is gone.
:::

If the team cannot create drives (`402` or `403` from Vercel), the runner logs the error, keeps new machines on snapshots, and tries again an hour later. A machine that already has a drive fails to start until the drive is reachable. To turn off drives for new machines, set `vercelDriveGiB` to 0.

Forking a machine with a drive needs Vercel drive forks. The runner checks for them every 10 minutes. Without them, Greenhouse hides the fork option. A machine without a drive forks from its snapshot.

### SSH bridge

Machines reach SSH through a bridge, which is the `orchard` CLI. By default, the server reads the expected SHA-256 from `checksums.txt` of the release that matches the server. To use a mirror, set `bridgeBinaryUrl` and `bridgeBinarySha256`.

A machine does not install a bridge it cannot verify. SSH to that machine fails until the checksum is available.

### Credentials

- **GitHub:** The host's GitHub token is set as a Vercel network policy that adds the `Authorization` header at Vercel's egress proxy. On `github.com`, the proxy adds the token only when a request carries the machine's placeholder credential, so a guest's own token keeps their identity. On `api.github.com`, it adds the token to each request, so `gh` and `curl` on the machine act as the host.
- **Claude and OpenAI:** Passed as environment variables to the bootstrap command on each start. They are not given to `Sandbox.create`.
- **Files:** `authorized_keys`, the opencode credentials, and project env files go to `/orchard-init`, with mode 600 for secret files.

### Public ports

Each exposed port has a public Vercel URL.

| Port          | Protection                                                                 |
| ------------- | -------------------------------------------------------------------------- |
| 4096          | HTTP basic authentication with a per-machine password.                     |
| 2222          | A per-machine bearer token. Behind it, `sshd` requires the host's SSH key. |
| Preview ports | None. The **Ports** tab labels them **Public**.                            |

The password and token are `HMAC-SHA256(SECRETS_ENCRYPTION_KEY, "orchard-sandbox:<purpose>:<machine id>[:<epoch>]")`. Orchard derives them on demand and does not store them. The epoch increases when a guest is removed or made read-only. Orchard then writes the new values to the machine and restarts the agent server. If you rotate `SECRETS_ENCRYPTION_KEY`, restart your Vercel machines.

:::caution
A snapshot and a drive contain the host's Claude token, the agent server password, the bridge token, the `dev` user's files, and project env files. Anyone with access to the Vercel project's sandboxes, snapshots, and drives can read them.
:::

## Configure previews

Vercel previews use Vercel's public URLs and need no configuration. Kubernetes previews need a domain of their own. Users open `https://<port>-<machine>.<previewDomain>/`.

1. **Choose a preview domain.** It must not be, contain, or sit under Orchard's cookie domain, Orchard's hostname, or a hostname in `PLATFORM_ORIGINS`. Previews run code that users wrote, and a same-site page could set cookies for Orchard. Orchard checks this when you save the setting, and turns previews off with a log line if the environment later makes the domain unsafe.
2. **Add wildcard DNS.** Point `*.<previewDomain>` at your ingress.
3. **Set the domain.** Set `sandbox.runners.previewDomain`, or **Preview domain** in **Greenhouse runners**.
4. **Add a route and a certificate.** With `sandbox.runners.previewDomain` set in the chart, the chart renders a Traefik IngressRoute on `ingress.entryPoints` and a cert-manager Certificate for `*.<previewDomain>`:

   | Value                             | Default                          | Notes                                                                                                                                       |
   | --------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | `sandbox.previews.route`          | `true`                           | Set to `false` to use your own route.                                                                                                       |
   | `sandbox.previews.tls.secretName` | `<release>-sandbox-previews-tls` | The Secret Traefik terminates TLS with.                                                                                                     |
   | `sandbox.previews.tls.issuerRef`  | `certificates.issuer`            | Wildcards need a DNS-01 issuer. With `certificates.enabled` off and no issuer, the chart renders no Certificate, and the Secret must exist. |

   Without the chart, create an equivalent route:

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
         match: HostRegexp(`^[0-9]{2,5}-[0-9a-f]{8}\.preview\.example\.com$`)
         services:
           - name: server
             port: 3001
     tls:
       secretName: wildcard-preview-tls
   ```

The Kubernetes runner then reports `previews: proxy` in its capabilities, or `none` without a usable domain.

## Set up integrations

### GitHub issues

`/greenhouse` comments arrive through the GitHub App that Orchard uses for deploys, on the same webhook URL. The GitHub App needs these settings:

1. **Repository permissions** > **Issues**: **Read and write**.
2. **Subscribe to events** > **Issue comment**.

An App created from **Instance admin** > **GitHub App** already has both. For another App, change them in its settings on GitHub. Each installation must then accept the new permission.

### Slack

1. Create a Slack app from this manifest. Replace the host.

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

2. Install the app to the workspace.
3. Go to **Instance admin** > **Configuration** > **Slack app**.
4. Enter the **Signing secret** from Slack's **Basic Information** page.
5. Enter the **Bot token** (`xoxb-...`) from Slack's **OAuth & Permissions** page.
6. (Optional) Enter the **App id** from **Basic Information**. Orchard then ignores events from any other app.

People then run `/greenhouse link` once each.

### Linear

1. In Linear, go to **Settings** > **API** > **Webhooks** and create a webhook.
2. Set the URL to `https://orchard.example.com/apiv1/integrations/linear/webhook`.
3. Select **Comments** under events.
4. Copy the signing secret to **Instance admin** > **Configuration** > **Linear** > **Webhook secret**.

Each person connects a personal Linear API key. That key identifies them and posts their replies.

### Verification and limits

| Endpoint                             | Verified by                                           | Rate limit      |
| ------------------------------------ | ----------------------------------------------------- | --------------- |
| `/apiv1/github/app/webhook`          | The GitHub App webhook secret                         | Same as deploys |
| `/apiv1/integrations/slack/commands` | Slack signing secret, timestamp within 5 minutes      | 120 per minute  |
| `/apiv1/integrations/slack/events`   | Slack signing secret, timestamp within 5 minutes      | 300 per minute  |
| `/apiv1/integrations/linear/webhook` | Linear signature, `webhookTimestamp` within 5 minutes | 120 per minute  |

Orchard records each delivery and ignores a repeat. Each person can start up to five sessions per minute from integrations.

## Settings reference

### Instance admin settings

These settings are in **Instance admin** > **Configuration**. Setting the environment variable locks the field. Saved changes reach every replica within 30 seconds.

**Greenhouse runners**

| Field                  | Variable                            | Default                         | Notes                                                                                     |
| ---------------------- | ----------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `kubernetesEnabled`    | `SANDBOX_RUNNER_KUBERNETES_ENABLED` | On                              |                                                                                           |
| `vercelEnabled`        | `SANDBOX_RUNNER_VERCEL_ENABLED`     | Off                             |                                                                                           |
| `defaultRunner`        | `SANDBOX_DEFAULT_RUNNER`            | First available runner          | `kubernetes` or `vercel`.                                                                 |
| `vercelToken`          | `SANDBOX_VERCEL_TOKEN`              |                                 | Secret.                                                                                   |
| `vercelTeamId`         | `SANDBOX_VERCEL_TEAM_ID`            |                                 |                                                                                           |
| `vercelProjectId`      | `SANDBOX_VERCEL_PROJECT_ID`         |                                 |                                                                                           |
| `vercelImage`          | `SANDBOX_VERCEL_IMAGE`              | `vercel/sandbox/universal`      |                                                                                           |
| `vercelVcpus`          | `SANDBOX_VERCEL_VCPUS`              | 2                               | 1 to 8.                                                                                   |
| `vercelTimeoutMinutes` | `SANDBOX_VERCEL_TIMEOUT_MINUTES`    | 60                              | 1 to 1440. Orchard extends the timeout by 30 minutes at a time while a machine is in use. |
| `vercelDriveGiB`       | `SANDBOX_VERCEL_DRIVE_GIB`          | 50                              | 0 to 16384. 0 turns drives off. Applies to new drives only.                               |
| `bridgeBinaryUrl`      | `SANDBOX_BRIDGE_BINARY_URL`         | The release matching the server | `https://` only. The Linux amd64 `orchard` CLI tarball.                                   |
| `bridgeBinarySha256`   | `SANDBOX_BRIDGE_BINARY_SHA256`      | From the release's checksums    | 64 hex characters. Required with `bridgeBinaryUrl`.                                       |
| `previewDomain`        | `SANDBOX_PREVIEW_DOMAIN`            |                                 | A bare domain. Refer to [Configure previews](#configure-previews).                        |

Turning a runner off stops new machines on it. Existing machines keep working.

**Slack app**

| Field           | Variable               | Notes                                  |
| --------------- | ---------------------- | -------------------------------------- |
| `signingSecret` | `SLACK_SIGNING_SECRET` | Required. Secret.                      |
| `botToken`      | `SLACK_BOT_TOKEN`      | Required. Secret. Starts with `xoxb-`. |
| `appId`         | `SLACK_APP_ID`         | Optional.                              |

**Linear**

| Field           | Variable                | Notes             |
| --------------- | ----------------------- | ----------------- |
| `webhookSecret` | `LINEAR_WEBHOOK_SECRET` | Required. Secret. |

### Environment variables

| Variable                       | Default                                   | Description                                                                    |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------ |
| `SANDBOX_NAMESPACE`            | `orchard-sandboxes`                       | Namespace for Kubernetes machines.                                             |
| `SANDBOX_IMAGE`                | `ghcr.io/hackclub/orchard/sandbox:latest` | Image for new Kubernetes machines.                                             |
| `SANDBOX_DEFAULT_AGENT`        | `opencode`                                | Agent for new sessions when none is selected, for example `acp:claude`.        |
| `SANDBOX_DAEMON`               |                                           | `off` stops the server from using the machine daemon.                          |
| `SANDBOX_WARM_POOL`            |                                           | `off` stops machines from keeping spare worktrees.                             |
| `SANDBOX_RUNTIME_CLASS`        |                                           | RuntimeClass, usually `kata`. Empty uses the default runtime.                  |
| `SANDBOX_HOME_MODE`            | `auto`                                    | `block`, `filesystem`, or `auto`, which is `block` when a RuntimeClass is set. |
| `SANDBOX_STORAGE_CLASS`        | Cluster default                           | StorageClass for home volumes.                                                 |
| `SANDBOX_DISK_SIZE`            | `10Gi`                                    | Home volume size for new machines.                                             |
| `SANDBOX_CPU_LIMIT`            | `2`                                       | CPU limit per Kubernetes machine.                                              |
| `SANDBOX_MEMORY_LIMIT`         | `4Gi`                                     | Memory limit per Kubernetes machine. Keep at least `1Gi` under Kata.           |
| `SANDBOX_TUNNEL_MODE`          |                                           | `portforward` for servers outside the cluster.                                 |
| `SANDBOX_MAX_PER_USER`         | `1`                                       | Default machine limit per person.                                              |
| `SANDBOX_IDLE_TIMEOUT_MINUTES` | `60`                                      | Stops running machines that are idle this long. `0` turns it off.              |
| `SANDBOX_MAX_LIFETIME_HOURS`   | `168`                                     | Stops machines this long after their last start. `0` turns it off.             |
| `SANDBOX_MCP_URL`              | Derived from the MCP host                 | The MCP endpoint for each machine's agent. Vercel machines require `https://`. |
| `ORCHARD_SERVER_NAMESPACE`     | `orchard`                                 | The server's namespace, used in the NetworkPolicy.                             |

For all server variables, refer to the [configuration reference](/reference/configuration/).

### Helm values

| Value                                                                                        | Maps to                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `sandbox.install`                                                                            | The namespace, quota, NetworkPolicy, RBAC, and `SANDBOX_*` settings |
| `sandbox.enabled`                                                                            | `install`, unless `install` is set                                  |
| `sandbox.namespace`                                                                          | `SANDBOX_NAMESPACE`                                                 |
| `sandbox.image`                                                                              | `SANDBOX_IMAGE`                                                     |
| `sandbox.runtimeClassName`                                                                   | `SANDBOX_RUNTIME_CLASS`                                             |
| `sandbox.idleTimeoutMinutes`                                                                 | `SANDBOX_IDLE_TIMEOUT_MINUTES`                                      |
| `sandbox.maxLifetimeHours`                                                                   | `SANDBOX_MAX_LIFETIME_HOURS`                                        |
| `sandbox.maxPerUserDefault`                                                                  | `SANDBOX_MAX_PER_USER`                                              |
| `sandbox.storageClass`, `diskSize`, `cpuLimit`, `memoryLimit`                                | The matching `SANDBOX_*` variables                                  |
| `sandbox.tunnelMode`, `homeMode`                                                             | `SANDBOX_TUNNEL_MODE`, `SANDBOX_HOME_MODE`                          |
| `sandbox.quota.*`                                                                            | The namespace ResourceQuota                                         |
| `sandbox.runners.default`                                                                    | `SANDBOX_DEFAULT_RUNNER`                                            |
| `sandbox.runners.kubernetes.enabled`                                                         | `SANDBOX_RUNNER_KUBERNETES_ENABLED`                                 |
| `sandbox.runners.vercel.enabled`                                                             | `SANDBOX_RUNNER_VERCEL_ENABLED`                                     |
| `sandbox.runners.vercel.tokenSecret`                                                         | `SANDBOX_VERCEL_TOKEN`, from a Secret you create                    |
| `sandbox.runners.vercel.teamId`, `projectId`, `image`, `vcpus`, `timeoutMinutes`, `driveGiB` | The matching `SANDBOX_VERCEL_*` variables                           |
| `sandbox.runners.bridgeBinaryUrl`, `bridgeBinarySha256`                                      | `SANDBOX_BRIDGE_BINARY_URL`, `SANDBOX_BRIDGE_BINARY_SHA256`         |
| `sandbox.runners.previewDomain`                                                              | `SANDBOX_PREVIEW_DOMAIN`, and the preview route and certificate     |
| `sandbox.previews.*`                                                                         | The preview route and certificate                                   |

A value under `sandbox.runners` left empty, or `null` for booleans, renders no variable. The field then stays editable in **Instance admin**.

## How machine changes apply

- **Writes are queued.** Creating, starting, stopping, deleting, and syncing credentials record the desired state and add an item to the apply queue. Workers retry with backoff from 5 seconds up to 10 minutes, for 10 attempts. After the last attempt, the machine keeps showing the error. To queue the change again, run `orchard sandbox retry <name>`.
- **Reads come from the Orchard Engine.** On Kubernetes, the `sandboxes` shard watches Sandbox resources, pods, volumes, and secrets (metadata only), and writes them to PostgreSQL.
- **Vercel is polled.** It has no watch API. The leader polls Vercel and writes what it sees to the same columns.

The queue drains only on a server that is a member of the cluster: in-cluster, or outside the cluster with `ORCHARD_CONTROL_NAMESPACE` and a kubeconfig. `APPLY_WORKER_DISABLED=true` makes a replica enqueue only.

## Machine daemon and agents

Each machine runs `orchard sandbox agentd` on port 4097. The server keeps one WebSocket per machine to it, authenticated with a per-machine bearer token. It runs the server's scripts, drives the coding agents, and keeps a pool of spare worktrees. If the daemon is not reachable, the server falls back to exec.

A session's chat runs on the built-in opencode server (`opencode`), or on an agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com): `acp:claude`, `acp:opencode`, `acp:fx`, or `acp:codex`. The daemon keeps each chat's events in `~/.orchard/chats/<chat>/events.jsonl`, and snapshots the worktree into `refs/orchard/checkpoints/` before each turn.

To add or override agents on a machine, create `~/.config/orchard/agents.json` with a list of `{ "id", "label", "command" }`. An entry with an empty `command` hides a built-in agent.

For the three repositories used most recently on a machine, the daemon keeps a spare worktree on the default branch, with the `setup` script already run. Creating a session claims the spare. The pool refetches every two minutes, and stops filling when the home disk is less than 20% free.

## Security model

### Roles

The host owns a machine. The host invites guests and read-only guests from the same organization. Organization admins of the machine's organization get lifecycle actions only. They can see the machine in lists, start, stop, or delete it, and retry failed changes. They cannot read its sessions, transcripts, comments, files, diffs, ports, previews, members, terminals, or agent server. Superadmins have host access. For the full table, refer to [What each role can do](/greenhouse/sharing/#what-each-role-can-do).

Each REST route checks the minimum role on the server. The live connection checks the role for each message type and drops writes from read-only guests. Terminal, SSH, and live connections recheck access every 15 seconds and when membership changes.

Each WebSocket upgrade authenticated by session cookie must come from one of Orchard's own origins. Upgrades on a preview host go only to the preview proxy.

API tokens restricted to specific projects cannot use Greenhouse. Sessions scoped to one organization reach only machines in that organization.

File reads and file operations resolve the path inside the machine. They refuse anything outside the session worktree or the repository, or directly under a dot directory of the home directory, including through symlinks. This keeps read-only guests and share links away from `~/.git-credentials`, `~/.config/orchard`, and `~/.claude`.

### Disclosure to guests

A guest runs the host's agent on the host's Claude subscription, with access to the host's files. The share sheet states that **Collaborate** uses the host's Claude and this machine. A guest sees a notice on first opening the machine, and must select **Continue**. For the full list of what guests receive, refer to [What sharing gives your guests](/greenhouse/sharing/#what-sharing-gives-your-guests).

### Where tokens are stored

| Token                                     | Stored                                                                                                                        | Reaches a machine as                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Claude and OpenAI tokens                  | Encrypted in PostgreSQL (AES-256-GCM)                                                                                         | The machine's Secret (Kubernetes) or bootstrap environment (Vercel)                        |
| The host's GitHub token, for the agent    | Encrypted in PostgreSQL                                                                                                       | The machine's Secret (Kubernetes), or an egress header (Vercel)                            |
| A person's GitHub token, for their pushes | Encrypted in PostgreSQL                                                                                                       | The environment of the one git command they run, or of their own terminal while it is open |
| Agent server password, SSH bridge token   | Not stored. Derived with HMAC from `SECRETS_ENCRYPTION_KEY` and the machine's epoch                                           | Files in `/orchard-init`, mode 600                                                         |
| Share link tokens                         | SHA-256 hash only                                                                                                             | Never                                                                                      |
| Slack link tokens                         | SHA-256 hash only, single use, 10 minutes                                                                                     | Never                                                                                      |
| Linear API keys                           | Encrypted in PostgreSQL                                                                                                       | Never                                                                                      |
| The agent's Orchard MCP token             | A 60-day token on a per-machine session of the host, confined to the machine's organization, and refused on superadmin routes | The agent's MCP configuration                                                              |

Tokens do not appear in these places:

- **The apply queue:** Items carry machine IDs only.
- **The Engine tables:** Secrets in the machine namespace are stored without their `data`.
- **Vercel's sandbox configuration:** Tokens are not passed to `Sandbox.create`.
- **Process arguments:** File contents and tokens reach a machine on stdin.
- **Logs, audit metadata, and live events:** Error reports and traces redact the token in older `/share/sandbox/<token>` URLs. Git output in the browser masks credentials in remote URLs.

Attached project env files skip names such as `GIT_*`, `LD_*`, `NODE_OPTIONS`, `PROMPT_COMMAND`, CA bundle variables, and `ANTHROPIC_BASE_URL`. An editor of an attached project therefore cannot redirect pushes or point the agent elsewhere. A preview deploy copies only plain variables from the source app.

### Remaining risks

- A guest with a terminal runs as the same user with `sudo`. A guest can read every credential on the machine, including the agent's MCP token and the agent server password.
- The host, other guests, and the agent can read a guest's GitHub token from the guest's terminal environment while it is open. They could also intercept a push by reconfiguring git on the machine.
- Vercel snapshots and drives, and therefore forks, contain the machine's secrets. On Kubernetes, the home volume holds the agent's GitHub credential.
- Issue text reaches the agent marked as untrusted data, and outsider-written issues need the host to start them. Prompt injection is reduced, not eliminated.
- Removing a guest does not undo what they did on the machine. Recreate the machine if you no longer trust someone who had access.

### Previews

Preview tickets are signed, single use, and valid for 60 seconds. The cookie they exchange for is `HttpOnly`, `Secure`, and `SameSite=Lax`, scoped to one preview host, and valid for 12 hours. Each request rechecks access, cached for up to 15 seconds.

Orchard strips its own cookies and authorization headers before a request reaches the machine. Cookies the app sets cannot name a parent domain. Orchard refuses cross-site requests. The server connects only to the allowed preview ports of the machine named in the host.

A preview WebSocket that is already open stays open after its user loses access, until either side closes it. On Vercel, previews are public URLs.

### Audit log

Greenhouse records these actions under `sandbox.`: `create`, `start`, `stop`, `delete`, `idle_stop`, `lifetime_stop`, `fork`, `keys.update`, `credentials.update`, `apply.retry`, `ssh.connect`, `terminal.open`, `terminal.reattach`, `terminal.denied`, `member.add`, `member.update`, `member.remove`, `member.leave`, `share_link.create`, `share_link.revoke`, `share_link.use`, `project.attached`, `project.detached`, `session.preview.deployed`, `session.preview.redeployed`, `session.preview.removed`, and `session.started_from`.

## Related resources

- [Greenhouse](/greenhouse/)
- [Install grafts](/grafts/install/)
- [Troubleshooting Greenhouse](/greenhouse/troubleshooting/)
