# Self-hosting Orchard

Orchard deploys onto an existing Kubernetes cluster via the Helm chart in
[`infra/charts/orchard`](../infra/charts/orchard). The chart installs
Orchard's own components (frontend, API server, MCP, Redis, control-plane
Postgres, image builders, metrics stack) but **no cluster operators**: you
bring the platform layer below it.

For a laptop-sized trial run, use the quickstart instead:

```bash
./scripts/quickstart.sh
```

It creates a local k3d cluster, installs the prerequisites, and deploys the
chart with dev values.

## Cluster prerequisites

| Component                                                                    | Needed for                                                                                       | Notes                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [CloudNativePG](https://cloudnative-pg.io) operator                          | Control-plane DB and every user database                                                         | The chart only creates `Cluster` resources                                                                                  |
| [Traefik](https://traefik.io) with Gateway API support                       | Control-plane ingress (`IngressRoute`) and user app routing (`HTTPRoute` via a shared `Gateway`) | Gateway API CRDs must be installed                                                                                          |
| [cert-manager](https://cert-manager.io)                                      | TLS certificates                                                                                 | Plus a DNS-01 `ClusterIssuer` if you want wildcard certs for the app domain (see `infra/charts/orchard/SETUP-wildcards.md`) |
| A default StorageClass                                                       | Postgres volumes, buildkit cache, Redis, metrics                                                 | Set `tenant.storageClass` / the chart `storageClass` values if it isn't the cluster default                                 |
| An OCI registry (e.g. [Harbor](https://goharbor.io))                         | Where built user images are pushed and pulled from                                               | Configure via `DOCKER_REGISTRY_PUSH` / `DOCKER_REGISTRY_PULL` / `REGISTRY_PROJECT` server env                               |
| An ingress controller for tenant ingresses                                   | Custom-domain ingresses for user apps                                                            | Class name via `tenant.ingressClass` (default `haproxy`)                                                                    |
| L4 LoadBalancer (e.g. [MetalLB](https://metallb.io))                         | Public database exposure and TCP/UDP passthrough                                                 | Only if you enable those features                                                                                           |
| gVisor / Kata RuntimeClasses                                                 | Sandboxed tenant/builder pods                                                                    | Optional; Talos-specific setup in `values.yaml`                                                                             |
| [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller | Greenhouse machines on the Kubernetes runner                                                     | Optional; only with `sandbox.enabled`. See [Greenhouse](#greenhouse-ai-dev-machines)                                        |
| Datadog agent                                                                | APM/tracing                                                                                      | Optional; `datadog.enabled: false` turns it all off                                                                         |

## ServiceAccount permissions

The chart creates the `orchard-server` ServiceAccount, the ClusterRole the
control plane needs, and a namespaced Role for the leader-election Leases.

Because tenant namespaces are created at runtime, the write grants can't be
namespaced Roles and are cluster-scoped: namespaces, pods (plus `exec` for the
web terminal), Deployments, Services, Ingresses, PVCs, NetworkPolicies, Jobs,
CronJobs, EndpointSlices, CNPG Clusters, and read/patch on nodes for the node
informer. Secrets and configmaps are deliberately _not_ granted cluster-wide.
The chart ships a second ClusterRole, `<release>-tenant-secrets`, that covers
only secrets and configmaps, and the server's own role may `bind` that one
ClusterRole by name and nothing else. When the server creates a tenant
namespace it adds a RoleBinding to it there, so it gains secrets access inside
namespaces it provisions and cannot write itself a broader role anywhere. The
chart tells the server the ClusterRole's name through
`TENANT_SECRETS_CLUSTER_ROLE`; without that variable (an older chart, or a
control plane run from an external kubeconfig) the server falls back to
minting a per-namespace Role as before.

None of this applies if you point the server at an external kubeconfig with
`KUBECONFIG_PATH` or `KUBECONFIG_BASE64`. It then acts as whatever identity
that file carries and ignores the ServiceAccount entirely, so the ClusterRole
above stops being the boundary. Prefer the in-cluster ServiceAccount unless the
control plane genuinely runs outside the cluster it manages.

If Cilium is your CNI, set `cilium.enabled: true` to add the
CiliumNetworkPolicy / CiliumEnvoyConfig grants that back per-tenant policy and
basic-auth-protected ingresses. Basic auth works without it too; see
[Protecting an ingress](#protecting-an-ingress) for how the enforcement point
is chosen.

> **Upgrading from a chart older than this change:** the ClusterRole was
> renamed from `<release>-image-builder-manager` to `<release>-server` and the
> ServiceAccount moved out from under `builders.enabled`.
>
> The new ClusterRole is a strict superset of the old one, and the
> ServiceAccount name is unchanged, so `helm upgrade` needs no special handling
> and there is no window where the server has fewer permissions than before.
> Helm won't garbage-collect the old objects though, so clean them up **after**
> the upgrade succeeds — not before, or you'll revoke permissions from the
> running pods:
>
> ```bash
> kubectl delete clusterrole,clusterrolebinding <release>-image-builder-manager --ignore-not-found
> ```
>
> If you previously worked around the missing permissions by binding
> `cluster-admin` to the ServiceAccount, drop that too, once you've confirmed
> the new role works:
>
> ```bash
> kubectl delete clusterrolebinding orchard-server-admin --ignore-not-found
> ```

## DNS

You need domains you control:

- **App domain** (`gateway.http.appDomain`, e.g. `apps.example.com`): wildcard
  DNS `*.apps.example.com` pointing at your Gateway's LoadBalancer IP, plus a
  wildcard certificate (DNS-01). This is the single source of truth: the chart
  derives the server's `APP_DOMAIN`, the frontend's `PUBLIC_APP_DOMAIN`, and
  `PLATFORM_WILDCARD_DOMAINS` (which generated app URLs like
  `main-forge-16294e.apps.example.com` are built from) from it. Override any of
  them individually via `server.env` / `frontend.env` /
  `tenant.wildcardDomains` if you need them to differ.
- **Ingress CNAME target** (`INGRESS_CNAME`): the hostname users point their
  custom domains at. Unset disables DNS validation for custom domains.
- **Platform domain**: where the Orchard UI itself lives (`ingress.host`).
- **DB domain** (`PUBLIC_DB_DOMAIN`, optional): wildcard for publicly exposed
  databases. Keep it in sync with `certificates.wildcards.db.domain`.
- **Public port domain** (`PUBLIC_DEPLOYMENT_DOMAIN`, optional): wildcard for
  publicly exposed deployment ports.
- **Vanity domain** (`BASE_DOMAIN`, optional): parent for org subdomains like
  `acme.example.com`.

These three are independent facts, not variations on the app domain. Each needs
its own DNS and wildcard certificate, and in practice they diverge: the Hack
Club cluster serves its UI from one domain, apps from a second, and org vanity
hosts from a third. So none of them is derived from another — guessing
`db.<appDomain>` would produce a hostname that doesn't resolve and a cert that
doesn't exist. Leave one unset and that feature turns off: public databases and
ports are addressed by `ip:port`, and org vanity subdomains are rejected with an
explanation rather than creating a broken ingress.

Note that a container `env` entry outranks every `envFrom` source in Kubernetes.
The chart therefore only injects `APP_DOMAIN` when you haven't set it yourself
in `server.env` and aren't using `server.envFrom` — otherwise it would silently
shadow a value you're supplying from a Secret.

The same applies to the app domain itself. With no `appDomain`, Orchard
generates no URLs and every deployment needs a custom domain — it never falls
back to a built-in default.

## Install

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard --create-namespace \
  -f my-values.yaml
```

The chart's [`AGENT.md`](../infra/charts/orchard/AGENT.md) is the full values
reference and troubleshooting guide. A minimal production values file
overrides at least:

```yaml
ingress:
  host: orchard.example.com
  tls:
    enabled: true
    # Either name a Secret you create yourself, or set issuerRef and the chart
    # issues the certificate for `host`. With neither, Traefik terminates using
    # its self-signed default cert and every browser rejects it.
    issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
gateway:
  http:
    appDomain: apps.example.com
tenant:
  storageClass: '' # empty = cluster default
  ingressClass: nginx
  certClusterIssuer: letsencrypt-prod
signupMode: invite_only
datadog:
  enabled: false
builders:
  harbor:
    username: robot$orchard
    password: <registry password>
    hosts: [registry.example.com]
server:
  env:
    - { name: DOCKER_REGISTRY_PUSH, value: registry.example.com }
    - { name: DOCKER_REGISTRY_PULL, value: registry.example.com }
    - { name: REGISTRY_PROJECT, value: orchard }
    - { name: INGRESS_CNAME, value: ingress.example.com }
    - { name: FRONTEND_URL, value: https://orchard.example.com }
    - { name: JWT_SECRET, valueFrom: { secretKeyRef: { name: orchard-secrets, key: jwt } } }
    - {
        name: SECRETS_ENCRYPTION_KEY,
        valueFrom: { secretKeyRef: { name: orchard-secrets, key: enc } }
      }
```

Login options out of the box: email OTP (needs `SMTP_*` env) and passkeys.

## First sign-in

A fresh instance has no accounts and no superadmin, and it very likely has no
`SMTP_*` env either, so it cannot deliver an OTP. The way in is a **claim
link**: a single-use token that creates the first account, makes it the
superadmin, creates its organization, and signs it in, all in one step.

The link is printed three ways, whichever suits you:

- in the closing box the installer prints when it finishes
- in the server log on first boot (`kubectl -n orchard logs deploy/server`)
- on demand, by running `sudo orchardctl claim` on the host

```
$ sudo orchardctl claim

  Open this to claim the instance and sign in (valid for 24 hours):

    https://orchard.example.com/setup/claim?token=T2SdKq...

  It works once. Add a passkey straight after so you can sign back in.
```

Opening it asks for the email address the account should use and nothing else.
No confirmation email is sent, and the address is left unverified until email
actually works, because the token proved you own the host, not the mailbox.

The token is only ever stored hashed, so a lost one cannot be read back.
`orchardctl claim` mints a replacement instead. It refuses once a superadmin
exists, and redeeming it is a single transaction, so it can't be replayed. The
only thing standing behind it is exec access on the server pod, which is
already equivalent to owning the instance.

### The setup flow

Claiming drops you into a three step gate, which blocks until the instance is
in a state where it actually works:

1. **A passkey.** Not skippable. With no email transport, a session that ends
   with no passkey registered locks you out of your own instance and there is no
   self-service way back in.
2. **Your organization.** Already created for you, named after your email
   domain, because everything else in Orchard hangs off one and there is no
   self-serve way to make one. This step only renames it, so skipping is safe.
3. **Your first deployment.** Shows every source Orchard can deploy from and
   completes inline for a container image or a public GitHub repo. Skippable.

The rule the gate is built on: **no skip may leave Orchard unusable**. Anything
whose absence would break the instance is either unskippable, or done for you
and demoted to customisation. It is enforced server-side, not just in the UI.

Steps are resumable, and `done` is always derived from the thing the step
produces rather than a stored flag, so deleting your last passkey reopens that
step instead of leaving a stale tick behind.

### Add a passkey immediately

**With no SMTP and no identity provider, a passkey is your only way back in.**
The claim link is one-time, so once you close that tab a session cookie is all
you have. Go to Settings and register one before doing anything else.

Passkeys need no external service, and passkey sign-in needs no email address:
Orchard uses discoverable credentials, so the login page can identify you from
the authenticator alone. They also require a **secure context**, so the
instance must be serving a real certificate first — a browser refuses WebAuthn
behind a self-signed cert. `WEBAUTHN_RP_ID` defaults to the hostname in
`FRONTEND_URL`, so there is normally nothing to configure.

If you lose every passkey on an instance with no email transport, there is
currently no self-service recovery. Configure `SMTP_*` or an identity provider
before you are relying on a single authenticator.

### Changing settings later

`orchardctl config` edits the values file the installer wrote and is the
intended way to change anything the install prompts didn't ask about:

```bash
sudo orchardctl config get signupMode
sudo orchardctl config set signupMode invite_only
sudo orchardctl config set ingress.tls.issuerRef.name letsencrypt
sudo orchardctl config set metrics.enabled false --apply
sudo orchardctl config list
sudo orchardctl config edit
```

Paths are dotted and are created if they don't exist, so setting
`ingress.tls.issuerRef.name` on a file that has no `issuerRef` block writes the
whole nesting. Values keep their YAML type: `false` and `2` land as a boolean
and an integer, a bare word stays a string.

Changes are written but **not deployed**. Pass `--apply` to run
`orchardctl update` straight after, or leave it off while you make several
edits and run `orchardctl update` once at the end.

The ones worth knowing:

| Path                         | What it does                                       |
| ---------------------------- | -------------------------------------------------- |
| `signupMode`                 | `open` / `invite_only` / `closed`                  |
| `ingress.tls.issuerRef.name` | ClusterIssuer for the Orchard UI's own certificate |
| `tenant.certClusterIssuer`   | ClusterIssuer for user app certificates            |
| `metrics.enabled`            | the built-in VictoriaMetrics stack                 |
| `cilium.enabled`             | Cilium-backed tenant policy and Envoy basic auth   |
| `protection.orchardLogin`    | offer "sign in with Orchard" on tenant hosts       |
| `server.replicas`            | control-plane API pods                             |

`orchardctl update` restarts each deployment whose image tag is a moving one
(`latest`, which is what the installer writes). Helm alone would not: the tag
string is unchanged between builds, so the pod template is identical, no new
ReplicaSet is written and nothing re-pulls — the upgrade reports success while
the old image keeps running. A deployment pinned to an exact version is left
alone, since for those the chart's own change is the signal.

It reads the values file as it finds it. It can't add settings that weren't there,
which is why an instance installed before a value existed needs
`orchardctl config set` first.

### Configuring email later

Email is optional for a single-operator instance and required the moment you
want to invite anyone, since invites and OTPs are both delivered over it. Set
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` in
`server.env` and re-run the upgrade.

Until then, OTP requests still generate a code and write it to the server log
rather than sending it:

```
[EmailService] SMTP_HOST not set — email sending is disabled
[DEV] OTP code for you@example.com: 481920
```

That is a usable fallback for a lone operator reading their own logs, and a
reason to keep `signupMode: invite_only` — the chart default. The installer
sets it too. Switching to `open` on an instance that can send email turns the
login page into public registration.

### Rate limits, replicas and client addresses

Every sign-in limit is keyed on an address, so two things have to be true for
them to mean anything.

**The counters have to be shared.** Set `REDIS_URL` on the server. Attempt
counters live in Redis so one limit covers the whole instance. Without it they
fall back to Postgres for the auth endpoints and to a per-pod map for the basic
auth gate, and that map multiplies the budget by `server.replicas`. The server
says which mode it is in at boot:

```
[RedisThrottleService] REDIS_URL not set: attempt counters are per-pod, so every limit multiplies by replica count
```

Attempts are counted when they are checked, atomically, in Redis or in
Postgres. A burst of parallel guesses cannot outrun the counter: once the
budget is spent every request in flight is refused.

**The address has to be the caller's, not a proxy's.** This needs no
configuration. A header carries no proof of who wrote it, so the only thing worth
trusting is position: Orchard walks the hops from the one nearest itself and
keeps going while each address is infrastructure it recognises. The first address
that is not is the caller.

Recognised without being told: loopback, private, link-local, unique-local and
carrier-grade NAT, which covers an in-cluster ingress controller of any flavour,
plus Cloudflare's published ranges. So a plain install behind ingress-nginx,
HAProxy or Traefik gets the right address, and so does the same install once you
put Cloudflare in front of it.

Counting hops instead would not survive that second step, and it is why
`TRUST_PROXY` is no longer the mechanism. It still works if you set it, pinning
an exact hop count the way Express does, and `TRUST_PROXY=0` still refuses to
read `X-Forwarded-For` at all.

| Variable               | When you need it                                        |
| ---------------------- | ------------------------------------------------------- |
| `TRUSTED_PROXY_RANGES` | a CDN or load balancer Orchard does not ship, as CIDRs  |
| `TRUST_CLOUDFLARE`     | `false` to stop treating Cloudflare's ranges as a proxy |
| `TRUST_PROXY`          | pin an exact hop count instead of detecting             |

`CF-Connecting-IP` is read only after an address Cloudflare itself must have
written has already been seen in the chain, so a request that reaches the origin
directly cannot forge it. What that does not defend against is a caller whose own
address is inside Cloudflare's ranges: reaching the origin directly from there,
they could name someone else and throttle that person instead. Restrict the
origin to your CDN's address ranges, at the load balancer or with a network
policy, and that goes away along with every other direct-to-origin concern.

### Cross-site requests

The session cookie is `SameSite=Lax`, and an app deployed on the platform can
share a site with the platform itself, so a form on a tenant app could once
post to the API with the visitor's cookie attached. Any request that changes
state and authenticates by cookie now has to come from a platform origin: the
browser's `Origin` header (or `Sec-Fetch-Site: same-origin`) must match
`FRONTEND_URL` or one of `PLATFORM_ORIGINS`. Bearer tokens are unaffected,
and so are reads. If a first-party page on another hostname posts to the API,
list its origin in `PLATFORM_ORIGINS` or it gets a 403.

### Bot protection on the sign-in pages

An instance reachable from the internet has three forms anyone can post to: the
sign-in card, the code box, and the password gate on a protected deployment.
Orchard rate-limits all three per address and per email, which stops one script
but not a botnet spread thin enough to stay under every bucket while still
mailing a code to every inbox it has scraped.

Cloudflare Turnstile closes that gap. It is off until you configure it. Create a
widget in the Cloudflare dashboard, then either set it in **Admin -> Instance ->
Bot protection**, or pin it from the host:

| Variable               | Default | What it is                                              |
| ---------------------- | ------- | ------------------------------------------------------- |
| `TURNSTILE_SITE_KEY`   |         | the public half, rendered in the widget                 |
| `TURNSTILE_SECRET_KEY` |         | the private half, only ever used server side            |
| `TURNSTILE_ENABLED`    | on      | `false` stops enforcing without discarding the keys     |
| `TURNSTILE_STRICT`     | off     | `true` refuses sign-in when the check cannot be reached |

Setting any of these in `server.env` locks that field in the admin panel, the
same as every other instance setting. Both keys must be present before anything
is enforced, so a half-finished configuration changes nothing, and turning the
toggle off is reversible in a way that deleting the keys is not.

Once enabled, these endpoints require a solved token: `POST /auth/otp/request`,
`POST /auth/otp/verify`, `POST /auth/password` and
`POST /auth/protect/exchange/password`.

By default verification **fails open**. If Cloudflare's siteverify cannot be
reached, or answers with an error, the request is allowed through unchallenged
and the server logs it at error level:

```
[TurnstileService] siteverify unreachable for signin: ECONNREFUSED
[TurnstileService] allowing signin unchallenged because the check could not be reached
```

That keeps a Cloudflare outage or a broken egress rule from taking your sign-in
page down with it. The trade is that anyone who can break that egress has turned
the protection off, so an instance that would rather be unavailable than
unprotected sets `TURNSTILE_STRICT=true` and gets a 503 instead.

Failing open does **not** cover a request that carries no token at all. That is
indistinguishable from a bot omitting the header, so it is always refused. The
practical consequence is that a browser extension which blocks the Turnstile
script leaves that person with a disabled button and "Bot check failed to load."
If that starts happening, turn the toggle off.

OAuth, SSO and passkey sign-in are untouched: those are challenged, or not, by
the identity provider that owns them.

## Host commands

The installer puts these on the host. They operate **this machine's** install
through helm and kubectl.

| Command                                           | Does                                                                     | Root |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| `orchardctl update`                               | `harden`, then `helm upgrade` to the latest chart and images             | yes  |
| `orchardctl harden`                               | registry on loopback with a password, firewall rules, private kubeconfig | yes  |
| `orchardctl config <get\|set\|unset\|list\|edit>` | read and change chart values                                             | yes  |
| `orchardctl claim`                                | mint a link to claim the instance and sign in                            | yes  |
| `orchardctl logs [service]`                       | follow logs, default `server`                                            | no   |
| `orchardctl status`                               | control-plane pods                                                       | no   |
| `orchardctl sync`                                 | refresh these commands from the deployed image                           | yes  |

`update`, `config` and `claim` need root: the values file is mode 0600, so
without it helm fails with `open /etc/orchard/values.yaml: permission denied`.

`harden` is what a fresh install already does, applied to an existing one.
Installs from before it existed published the image registry as a node port
with no password, left the firewall for k3s to fight with, and wrote a
world-readable kubeconfig. `update` runs it first, so an upgrade fixes an old
box on its way through; it is idempotent and safe to run by hand.
Each also exists hyphenated (`orchard-update`, `orchard-config`,
`orchard-claim`) — those are the real entry points, and the nightly update
timer calls `orchard-update` directly.

**`orchardctl` is not the `orchard` CLI.** They're different tools with
different jobs, which is why the operator one carries the `ctl` suffix:

|              | `orchard`                                        | `orchardctl`                              |
| ------------ | ------------------------------------------------ | ----------------------------------------- |
| Who          | anyone with an account                           | whoever runs the server                   |
| Talks to     | any instance's HTTP API                          | this host's helm release and cluster      |
| Does         | deploy apps, tail builds, manage env and domains | upgrade, edit values, claim, inspect pods |
| Installed by | you, per workstation                             | `install.sh`, on the host                 |

### Keeping the host commands current

They ship inside the server image at `/app/hostbin`, so `orchardctl update`
copies them out after the rollout and a release that fixes one lands on the
host with it. No installer re-run, no separate download.

Each candidate is checked before it replaces the live copy: non-empty, starts
with a shebang, and passes `bash -n`. A truncated read would otherwise leave
you with no way to upgrade or claim, which is the worst thing this could do, so
a file that fails any check is skipped and the existing one stays.

To refresh them without a full upgrade:

```bash
sudo orchardctl sync
```

They run as they sit in the image, with no install-time rendering, so
bootstrapping on a host that has none of them yet is a plain copy:

```bash
sudo kubectl -n orchard exec deploy/server -- cat /app/hostbin/orchard-sync-commands \
  | sudo tee /usr/local/bin/orchard-sync-commands > /dev/null
sudo chmod +x /usr/local/bin/orchard-sync-commands
sudo orchard-sync-commands
```

Paths come from `/etc/orchard/env` when it exists and from built-in defaults
when it doesn't.

Re-running the installer also works and is the only way to change answers you
gave at install time (domains, ingress mode, update policy). It skips k3s, helm
and the operators when they're already present, and carries `JWT_SECRET`,
`SECRETS_ENCRYPTION_KEY` and `SSO_ENCRYPTION_KEY` over from the existing values
file rather than minting new ones — a fresh encryption key would make every
secret already in the database permanently undecryptable. Values you changed
with `orchardctl config` are **not** preserved, so note them with
`orchardctl config list` first.

### When an upgrade says a Certificate can't be imported

```
Error: UPGRADE FAILED: Unable to continue with update: Certificate "orchard-tls"
in namespace "orchard" exists and cannot be imported into the current release:
invalid ownership metadata
```

The chart now issues the control-plane certificate itself, so an instance where
one was created by hand before upgrading has an object Helm didn't create and
won't take over. Hand it to Helm rather than deleting it, so the certificate
already issued is kept and no new ACME order is placed:

```bash
kubectl -n orchard label certificate orchard-tls \
  app.kubernetes.io/managed-by=Helm
kubectl -n orchard annotate certificate orchard-tls \
  meta.helm.sh/release-name=orchard \
  meta.helm.sh/release-namespace=orchard
```

Then re-run the upgrade. Deleting it works too — cert-manager leaves the Secret
behind and the chart re-issues — but it spends one of Let's Encrypt's five
duplicate certificates per week for no reason.

The same applies to any object you created by hand that the chart later
started managing.

### When an upgrade says one is already in progress

```
Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress
```

A previous helm operation was interrupted and the release is stuck in a pending
state. Check it, then roll back to the last good revision:

```bash
sudo helm -n orchard history orchard
sudo helm -n orchard rollback orchard <last DEPLOYED revision>
sudo orchardctl update
```

If the stuck revision is the very first install there is nothing to roll back
to, so `sudo helm -n orchard uninstall orchard` and re-run the install. That
drops the chart's resources but not the Postgres PVC, so data survives.

## Footprint and scaling

Requests are sized for what the control plane consumes at rest, not for its
peak, since requests are what the scheduler actually reserves. At defaults with
one replica each, the control plane requests roughly 1 GiB of memory.

The bundled metrics stack (VictoriaMetrics, vmagent, kube-state-metrics,
node-exporter) is the single largest idle cost, and VictoriaMetrics sizes its
cache as a share of its memory _limit_, so it grows to fill whatever it is
given. On a small cluster:

```yaml
metrics:
  enabled: false
```

turns it off entirely — the deployment metrics graphs and usage pages go empty,
everything else is unaffected. To keep it but shrink it, lower
`metrics.victoriametrics.resources.limits.memory` and
`metrics.victoriametrics.memoryAllowedPercent`. The one-command installer
enables the stack only on hosts with 8 GB or more; `--metrics true|false`
overrides that.

The stateless tiers can scale on CPU instead of running a fixed replica count.
This needs metrics-server (k3s ships it):

```yaml
server:
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 8 }
frontend:
  autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 6 }
```

Scaling out is faster than scaling in (60s up, 5 min down), so a burst is
absorbed promptly without dropping capacity during a brief lull. When
autoscaling is on, the chart omits `replicas` from that Deployment so a
`helm upgrade` can't stomp on what the autoscaler settled at — which also means
`replicas` in your values is ignored for that tier.

`server.workers` moves builds and the apply queue onto their own pods and has
its own autoscaling block; it's the burstiest tier and benefits most.

### Pod shells across replicas

A pod shell opened from the dashboard is an exec session held in memory by
the API pod that opened it. If the browser drops (wifi blip, laptop sleep,
closed tab) the session stays alive for `EXEC_DETACH_GRACE_MS` (10 minutes
by default) with its output buffered, and the same tab reattaches with that
output replayed, so a running `vim` or `htop` picks up where it was.

With `server.replicas` above one there is no sticky routing, so a reattach
can reach a pod that does not hold the session. That pod looks the session
up in Redis and proxies the connection to the owner over the pod network,
which is why the chart sets `POD_IP` on the server and why Redis is required
for this to work across replicas. Set `EXEC_SESSION_PROXY=false` to turn the
hop off; the browser then gets a fresh shell and a one-line message rather
than a hang.

Sessions do not survive the API pod being replaced on an upgrade, so keep
`EXEC_DETACH_GRACE_MS` at or below your rollout's old-pod scale-down delay
to avoid two different failure modes. If the container image has `tmux`,
the shell runs inside a tmux session named after the exec session and the
same tab reattaches to it even after an upgrade.

## Single sign-on

SSO is configured in the UI, at two levels.

**Platform-wide** (Admin -> SSO): identity providers offered to everyone on
the login page. Pick a preset (Google, Microsoft Entra, GitHub, GitLab, Okta,
Auth0, Keycloak, Authentik, OneLogin, JumpCloud) or configure a generic
OpenID Connect or SAML 2.0 provider, paste the client credentials, and copy
the redirect URL it generates into the provider. Each connection carries its
own policy: whether it may create accounts, the role new members get, an
optional email-domain allowlist, and whether a verified email is required.

The same page has the per-organization kill switch. Turning SSO off for one
organization leaves its configuration intact but stops sign-ins, and the org
owner cannot re-enable it from their own settings.

**Per organization** (org settings -> SSO): an org configures its own
providers the same way, and gets a branded login page at
`https://<your-domain>/<org-slug>`, with no subdomain to set up. An org that
has verified an email domain also captures anyone typing a matching address on
the platform login page. "Require single sign-on" blocks email
codes, passkeys, and platform providers for that org's members.

Single sign-on is off for every organization until a platform administrator
allows it. An organization proves it owns an email domain by publishing a TXT record at
`_orchard-challenge.<domain>`. Verification is what allows an org's provider to
create accounts for people at that domain who have never signed in before, and
what routes those addresses to its login page. Only one organization can hold a
domain. Without it, an org's members join by invitation, where the emailed link
proves the recipient holds the mailbox.

Secrets (client secrets, signing certificates) are encrypted at rest with
`SSO_ENCRYPTION_KEY`; without it the server refuses to store them.

IdP URLs pointing at internal addresses (loopback, RFC1918, `.svc`,
`.cluster.local`, cloud metadata) are rejected at save time, since they drive
server-side fetches. If your IdP genuinely runs on internal DNS, set
`SSO_ALLOW_INTERNAL_IDP=true`.

Two rules keep an organization's provider from being turned against the
organization. **Provider management is owner-only**: creating, editing,
testing or deleting an org's identity providers and domains, and toggling
enforcement, needs the org owner role; admins can read the configuration but
not change it. **An owner only signs in through a provider they set up
themselves.** The provider records who created it, and a sign-in that resolves
to an owner is refused unless that owner is the creator, so an admin cannot
point a provider at an identity provider they control and assert the owner's
address. Providers that predate this rule are attributed to the organization's
owner by the migration, so nobody is locked out; a second owner of the same
org signs in another way.

SAML requests are tracked and every assertion must answer one Orchard issued.
That closes replay and login-CSRF, and it means identity-provider-initiated
sign-in (clicking the app tile in the IdP's portal) no longer works: users
start from the Orchard login page or the org's branded one. Request ids live
in Redis when `REDIS_URL` is set, otherwise in memory, so a multi-replica
instance without Redis will fail SAML sign-ins that land on a different
replica.

A single env-configured provider is still supported and renders alongside the
database ones: `AUTH_PROVIDER=oidc` plus the `AUTH_OAUTH_*` env, or
`AUTH_PROVIDER=hackclub` for the Hack Club preset. `AUTH_PROVIDER=none`
disables it. SCIM provisioning is configured per organization in the UI.

## Tenant quotas

Every tenant namespace carries a ResourceQuota. Organization and project caps
set the CPU, memory, pod and service lines; when a cap is unset the namespace
still gets a floor of 200 pods, 100 services, 50 volume claims and 500 GiB of
requested storage, so an uncapped instance cannot be filled by one tenant.
The floor is tunable with `TENANT_QUOTA_FLOOR_PODS`,
`TENANT_QUOTA_FLOOR_SERVICES`, `TENANT_QUOTA_FLOOR_PVCS` and
`TENANT_QUOTA_FLOOR_STORAGE_BYTES` on the server.

## Database backups and the proxy

Managed databases archive to R2 through `r2-proxy`, a small service that
holds the real bucket credentials and hands each database cluster a
per-cluster key that only works for its own prefix. The proxy verifies the
SigV4 signature on every request, refuses copy operations and every
bucket-level write except a multi-object delete whose keys all sit inside the
caller's prefix, and only serves the buckets named in `ALLOWED_BUCKETS`
(default: the platform bucket). An organization that brought its own bucket
and keys talks to it directly and never goes through the proxy.

The proxy reads its bindings from the platform database as `orchard_r2_proxy`,
a login role the CNPG cluster manages with a password the chart keeps in the
`orchard-r2-proxy-db` secret and holds stable across upgrades. The server
grants that role `SELECT` on the three tables it needs at every boot. On the
first upgrade to this scheme backup lookups can fail for a few seconds until
the grant lands, then recover on their own. `r2Proxy.databaseUrl` points the
proxy somewhere else entirely for a database the chart does not run.

## Node scheduling

Superadmins manage cluster nodes under Admin -> Nodes: cordon, set taints and
labels (Orchard patches the live node; a node informer mirrors state back into
the DB so reads never hit the kube-apiserver), and define **node pools**. A
pool maps a friendly name to a node label selector plus tolerations to inject,
so a workload assigned to it lands on (and tolerates) the intended nodes. Example:
taint a cheap background box `orchard.io/pool=background:NoSchedule`, label it
`orchard.io/pool=background`, create a "Background" pool that selects that label
and tolerates that taint, then assign your queue runner to it. Web workloads left
unassigned carry no toleration and never schedule there.

By default only superadmins assign pools. A superadmin can flip "Userspace
scheduling" under Admin -> Nodes to let normal users pick a pool that was marked
user-selectable. The `USERSPACE_NODE_SCHEDULING` env var overrides that toggle
when set (`true` forces it on, `false` forces it off and locks the switch);
leave it unset to control the feature from the UI. Pool placement applies to app
deployments, jobs, and CNPG databases.

## TLS for app URLs

Every app gets a URL under your app domain, and each one needs a certificate.
There are two ways to get them, and the default needs no setup.

### Per host, the default

With no wildcard configured, each host gets its own certificate issued over
HTTP-01 against `tenant.certClusterIssuer`. Nothing to configure, no DNS
credentials, and the certificate lands directly in the namespace that uses it.

The ceiling is Let's Encrypt's issuance limits:

| Limit                                       | Value                                      |
| ------------------------------------------- | ------------------------------------------ |
| Certificates per registered domain          | 50 per 7 days, refilling 1 per 202 minutes |
| Duplicate certificates (identical name set) | 5 per 7 days, no overrides                 |
| New orders per account                      | 300 per 3 hours                            |
| Failed validations                          | 5 per identifier per hour                  |

Two things to know about that first row. It refills continuously rather than
resetting weekly, so the sustained rate is roughly 7 new URLs a day with a burst
of 50. And "registered domain" means eTLD+1: `apps.example.com`,
`orchard.example.com` and every generated app URL share **one** budget across
all of `example.com`. Overrides are available from Let's Encrypt on request.

Past roughly 50 new URLs a week, switch to a wildcard.

### A wildcard, once you outgrow it

One certificate covers every host under the domain, so issuance stops counting
against anything. It needs DNS-01, because a wildcard cannot be validated over
HTTP-01.

**1. A DNS-01 issuer.** cert-manager supports these providers natively, with no
webhook: Cloudflare, Route53, AzureDNS, Google CloudDNS, DigitalOcean, Akamai,
ACMEDNS and RFC2136. For Cloudflare a token scoped to `Zone:DNS:Edit` on the one
zone is enough:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef:
      name: letsencrypt-dns01
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
```

If you would rather not hand cert-manager a registrar token, delegate the
challenge instead: point `_acme-challenge.apps.example.com` at a zone you don't
mind it writing to and use the `acmeDNS` solver. That is what the Hack Club
cluster does.

**2. Point the chart at it.**

```yaml
certificates:
  enabled: true
  issuer: { name: letsencrypt-dns01, kind: ClusterIssuer }
  copyToTenants: true
tenant:
  wildcardDomains: '.apps.example.com=wildcard-apps-example-com-tls'
```

**3. Understand `copyToTenants`.** A wildcard is issued once, into
`certificates.namespace`, but every tenant Ingress references the Secret by name
in **its own** namespace. Something has to copy it there or those hosts serve
nothing. Orchard does that itself on a five minute reconcile, which is why no
extra component is needed.

Leave `copyToTenants: false` if you already run a secret replicator such as
[reflector](https://github.com/emberstack/kubernetes-reflector) or kubed. Two
controllers replacing the same Secret each strip the other's metadata and
rewrite in a loop.

### When a certificate does not issue

Orchard reads `Certificate` status back and shows it per domain, so a failure
says what went wrong rather than only appearing as a browser warning. The common
causes are DNS not yet pointing at the cluster, port 80 unreachable for the
HTTP-01 challenge, a CAA record excluding Let's Encrypt, and the rate limits
above. A rate-limit failure is called out separately because its fix is a
wildcard rather than anything about that host.

## Protecting an ingress

Orchard can put an auth wall in front of a tenant host. Three modes, and only
one of them needs anything from the cluster:

| mode       | what a visitor sees                                              | requirements                    |
| ---------- | ---------------------------------------------------------------- | ------------------------------- |
| `basic`    | the browser's username/password dialog (HTTP Basic, RFC 7617)    | none                            |
| `password` | an Orchard-hosted page asking for one shared password            | none                            |
| `orchard`  | "sign in with Orchard", and they must be a member of the project | `protection.orchardLogin: true` |

Set them with `PUT /apiv1/projects/:id/ingresses/:ingressId/protection`, body
`{ mode, username?, password?, bypassPaths? }`. `username` is only read for
`basic`. `bypassPaths` (up to 20) exempts webhook and healthcheck routes from
whichever wall is up.

Basic auth is also reachable as a `basicAuth` block when you create or update
an ingress, including from a template's `ingress:` config. That form is
equivalent to setting `mode: basic`, and it works on every cluster.

### How basic auth is enforced

There are two enforcement points and the cluster picks which one:

- **With Cilium**, Orchard writes a `CiliumEnvoyConfig` that puts an Envoy
  `basic_auth` filter in front of the backing Service. This is the stronger
  option: the password covers every path into that Service, including traffic
  that never passed your ingress controller.
- **Without Cilium**, the same credentials are checked by Orchard's protection
  proxy. The ingress backend is repointed at a headless Service that resolves
  to the control plane, which answers `401 WWW-Authenticate: Basic` until the
  right credentials arrive and proxies through once they do. No CNI features,
  no ingress-controller annotations, no CRDs.

The server decides by probing for the `cilium.io` API group and its own
permission to create `ciliumenvoyconfigs`, so nothing needs configuring either
way. `cilium.enabled: true` grants that permission and skips the probe;
`CILIUM_ENABLED=true|false` in `server.env` forces the answer.

The two differ in one way worth knowing: the proxy gates the HTTP route, so
anything already inside the cluster that can reach the pod directly is
unaffected. If that matters, pair it with a NetworkPolicy.

Passwords are stored bcrypt-hashed either way. The Envoy path additionally
derives the SHA-1 htpasswd string its filter needs, which is why the username
is stored alongside.

### "Sign in with Orchard"

`mode: orchard` redirects visitors to the control plane's login page and then
checks project membership, so it only makes sense when the people you are
gating already have Orchard accounts, and it needs `FRONTEND_URL` reachable
from wherever the app is served. The chart ships it off:

```yaml
protection:
  orchardLogin: true
```

The flag gates _choosing_ the mode, not enforcing it. Turning it off does not
drop the wall on hosts that already use it, so an upgrade cannot silently
publish something that was private.

It also does not affect the generated URL a new deployment gets on the platform
wildcard domain. That one is member-gated from birth on purpose, and the people
it gates are project members, who have accounts on this instance by definition.
So you will still see `protectionMode: orchard` rows with the flag off.

### Gating at your ingress controller instead

Nothing stops you doing it yourself. Create the htpasswd Secret in the
deployment's namespace and set the annotations your controller expects, e.g.
for ingress-nginx:

```bash
htpasswd -nbB alice 's3cr3t' > auth
kubectl -n <tenant-namespace> create secret generic my-app-basic-auth --from-file=auth
```

```yaml
nginx.ingress.kubernetes.io/auth-type: basic
nginx.ingress.kubernetes.io/auth-secret: my-app-basic-auth
nginx.ingress.kubernetes.io/auth-realm: 'Restricted'
```

HAProxy uses `haproxy.org/auth-secret`; Traefik wants a `basicAuth` Middleware
referenced from `traefik.ingress.kubernetes.io/router.middlewares`. Pass these
through the ingress's `annotations` field. Orchard only forwards annotation
keys on its allowlist (`ALLOWED_INGRESS_ANNOTATION_KEYS` in
`apps/server/src/kubernetes/kubernetes.service.ts`), and none of the ones above
are on it yet, so add the ones you need there first.

## Greenhouse (AI dev machines)

Greenhouse gives people cloud machines with coding agents on them, worktree
sessions, a browser IDE and multiplayer sharing. It is off by default. The full
operator guide, with every setting, the Slack app manifest and the security
model, is on the docs site under **Operating Orchard → Running Greenhouse**
(`apps/docs/src/content/docs/operate/greenhouse.md`); the design is in
[`docs/ai-sandbox.md`](ai-sandbox.md). The short version:

**The switch.** `SANDBOX_ENABLED` pins it (`true`/`false`, locks the admin
switch); unset, admins flip it at **Admin -> Configuration**, off by default in
production. `sandbox.enabled: true` in the chart sets it and renders the
namespace, quota, NetworkPolicy and RBAC the Kubernetes runner needs.

**Runners.** Machines run on the instance's own cluster (`kubernetes`) or on
Vercel Sandbox (`vercel`). Enable either at **Admin -> Configuration -> Sandbox
runners** or with `SANDBOX_RUNNER_KUBERNETES_ENABLED` /
`SANDBOX_RUNNER_VERCEL_ENABLED`, and pick `SANDBOX_DEFAULT_RUNNER`. Turning a
runner off never strands machines already on it.

- **Kubernetes** needs the agent-sandbox controller and CRDs (pinned, installed
  out of band), ideally a Kata RuntimeClass (`sandbox.runtimeClassName`; empty
  runs unprivileged on runc), and a VolumeSnapshotClass if you want forking. No
  custom image: a bootstrap script installs the tools into `debian:bookworm`.
- **Vercel** needs a token (from a Secret, `sandbox.runners.vercel.tokenSecret`),
  team id, project id and `SECRETS_ENCRYPTION_KEY`. Vercel ports are public: the
  agent server and SSH bridge are protected by per-machine secrets derived from
  that key, preview ports are not. Persistent snapshots contain the machine's
  secrets.

**Everything is queued.** Machine changes go through the apply queue and the
`sandboxes` engine shard like deployments do. The queue drains only on servers
that are members of the cluster, so a laptop pointed at production enqueues and
never applies.

**Previews** on Kubernetes need `SANDBOX_PREVIEW_DOMAIN`: a domain that is not,
does not contain and is not under Orchard's cookie domain or hostnames, with
wildcard DNS and a wildcard certificate, and an IngressRoute you add that sends
every path on `*.<previewDomain>` to the `server` service:

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata: { name: orchard-sandbox-previews, namespace: orchard }
spec:
  entryPoints: [websecure]
  routes:
    - kind: Rule
      match: HostRegexp(`^[0-9]+-[0-9a-f]{8}\.preview\.example\.com$`)
      services: [{ name: server, port: 3001 }]
  tls: { secretName: wildcard-preview-tls }
```

**Integrations.** `/greenhouse` on GitHub issues needs the GitHub App to have
**Issues: Read and write** and the **Issue comment** event, which the manifest
flow does not request; add them in the App's settings. Slack needs an app with
the `/greenhouse` command, the `app_mention` event and the `app_mentions:read`,
`chat:write` and `commands` scopes (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
optional `SLACK_APP_ID`). Linear needs a Comments webhook to
`/apiv1/integrations/linear/webhook` (`LINEAR_WEBHOOK_SECRET`). People link
their Slack and Linear accounts themselves; nothing is matched by email.

**Limits.** `SANDBOX_MAX_PER_USER` (1), `SANDBOX_IDLE_TIMEOUT_MINUTES` (60),
`SANDBOX_MAX_LIFETIME_HOURS` (168), plus the chart's `sandbox.quota`.

**PostHog.** With `POSTHOG_API_KEY` set, Greenhouse is also gated per person by
the `greenhouse` feature flag.

## Anonymous usage reports

Orchard can send the Orchard team a short report once a day, so we know which
features people rely on and which crashes to fix first. Nothing is sent until a
superadmin says yes. A fresh instance asks during setup; an instance that
predates this asks every superadmin once with a prompt, until one of them
answers. Nobody else sees it. Change the answer any time under
**Admin -> Configuration**, which also shows the exact report this instance
would send.

The daily report carries only counts and yes/no answers:

- the Orchard and Node.js versions and the CPU architecture
- how many users there are, and how many were active in the last day, week and
  month
- how many organizations, projects, deployments, databases, jobs, sandboxes
  and nodes exist
- how many builds succeeded and failed in the last 24 hours
- whether GitHub, email, backups, SSO, MCP and node scheduling are turned on

With reports on, an unexpected server error (a 5xx, or a crash outside a
request) also sends its type, the route pattern (`/deployments/:id`, never the
real URL), and the file, function and line in Orchard's own code where it
happened. The error message is never sent, because messages are where data
leaks in.

No names, emails, domains, repositories, environment variables or logs are
sent, and IP addresses are not stored. Every report is keyed to a random ID
generated for this instance and nothing else. Reports go to PostHog at
`us.i.posthog.com`, so that is the one host to allow if your egress is locked
down.

To decide for every superadmin up front, set `ORCHARD_TELEMETRY` on the server:
`false` turns reports off and locks the switch, `true` turns them on without
asking.

```yaml
server:
  env:
    - { name: ORCHARD_TELEMETRY, value: 'false' }
```

## What is not included

- Cluster bootstrap (nodes, CNI, operator installation): bring your own or
  see the quickstart for a local reference stack.
- DNS-01 issuer credentials and wildcard issuance: documented in
  `SETUP-wildcards.md`, secrets stay in your ops repo.
- Database backup schedules: CNPG `ScheduledBackup` resources are yours to
  define; the r2-proxy component brokers per-cluster credentials when
  enabled.
