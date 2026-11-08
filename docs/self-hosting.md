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
chart with dev values. Image builds are off, and its secrets are public, so
keep it on your laptop.

## Cluster prerequisites

| Component                                                                    | Needed for                                                                       | Notes                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [CloudNativePG](https://cloudnative-pg.io) operator                          | Control-plane DB and every user database                                         | The chart only creates `Cluster` resources                                                                                  |
| [Traefik](https://traefik.io)                                                | Control-plane ingress (`IngressRoute`)                                           |                                                                                                                             |
| Gateway API CRDs                                                             | The chart's `Gateway` for database exposure                                      | Not needed with `gateway.enabled: false`                                                                                    |
| [cert-manager](https://cert-manager.io)                                      | TLS certificates                                                                 | Plus a DNS-01 `ClusterIssuer` if you want wildcard certs for the app domain (see `infra/charts/orchard/SETUP-wildcards.md`) |
| A default StorageClass                                                       | Postgres volumes, buildkit cache, Redis, metrics                                 | Set `tenant.storageClass` / the chart `storageClass` values if it isn't the cluster default                                 |
| An OCI registry (e.g. [Harbor](https://goharbor.io))                         | Where built user images are pushed and pulled from                               | Configure via `DOCKER_REGISTRY_PUSH` / `DOCKER_REGISTRY_PULL` / `REGISTRY_PROJECT` server env                               |
| An ingress controller                                                        | Every app URL. The server creates an `Ingress` per host and never an `HTTPRoute` | Class name via `tenant.ingressClass` (default `haproxy`)                                                                    |
| L4 LoadBalancer (e.g. [MetalLB](https://metallb.io))                         | Public database exposure and TCP/UDP passthrough                                 | Only if you enable those features                                                                                           |
| gVisor / Kata RuntimeClasses                                                 | Sandboxed tenant/builder pods                                                    | Optional; Talos-specific setup in `values.yaml`                                                                             |
| [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller | Greenhouse machines on the Kubernetes runner                                     | Optional; only with `sandbox.enabled`. See [Greenhouse](#greenhouse-ai-dev-machines)                                        |
| Datadog agent                                                                | APM/tracing                                                                      | Optional; `datadog.enabled: false` turns it all off                                                                         |

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
  DNS `*.apps.example.com` pointing at your ingress controller's LoadBalancer
  IP. Each host gets its own certificate unless you add a wildcard (see
  [TLS for app URLs](#tls-for-app-urls)). This is the single source of truth: the chart
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
- **Vanity domain** (`BASE_DOMAIN`, optional): parent for org subdomains and
  status pages like `acme.example.com`. Their Ingresses are created in the
  release namespace and point at the chart's `frontend` Service. The chart sets
  `PLATFORM_NAMESPACE`, `PLATFORM_SERVICE_NAME` and `PLATFORM_SERVICE_PORT` for
  that, and passes the domain to the frontend as `PUBLIC_BASE_DOMAIN` with
  `PUBLIC_PLATFORM_ORIGIN`. With `server.envFrom` it sets none of these, so put
  them in your Secret and `frontend.env`, or the server falls back to
  `default/leaf-frontend:3000`.

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

To install Orchard on a cluster you operate, install the prerequisites, write a
values file, and install the chart.

**What was tested.** These steps were run end to end on one node: k3s v1.36.5 with
its bundled Traefik, Helm 4.3.1, Let's Encrypt over HTTP-01, and a registry behind
an ingress on the same node. The run reached a working sign-in, an app built from a
repository and served over HTTPS, and two healthy databases. That run set
`CNPG_OPERATOR_NAMESPACE` in `server.env`. The `tenant.cnpgOperatorNamespace` value
used below sets the same variable. Its rendered output is checked in CI, but it has
not been run on a cluster.

These were not tested on this path: backups with the `objectStorage` values, MCP,
public database exposure, more than one node, and other ingress controllers.

### Install the prerequisites

k3s includes Traefik and the `local-path` StorageClass, so these steps do not
install them.

1. Install the Gateway API CRDs:

   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
   ```

2. Install CloudNativePG and cert-manager:

   ```bash
   helm repo add cnpg https://cloudnative-pg.github.io/charts
   helm repo add jetstack https://charts.jetstack.io
   helm repo update
   helm upgrade --install cnpg cnpg/cloudnative-pg \
     --namespace cnpg-system --create-namespace --wait --timeout 10m
   helm upgrade --install cert-manager jetstack/cert-manager \
     --namespace cert-manager --create-namespace \
     --set crds.enabled=true --wait --timeout 10m
   ```

3. Point DNS for your dashboard domain and app domain at the ingress controller.
   Let's Encrypt must be able to reach port 80 on these hostnames.

4. Create a ClusterIssuer. This one issues Let's Encrypt certificates over HTTP-01:

   ```bash
   kubectl apply -f - <<'EOF'
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: letsencrypt
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       privateKeySecretRef:
         name: letsencrypt-account-key
       solvers:
         - http01:
             ingress:
               class: traefik
   EOF
   ```

To add Traefik to a cluster that does not have it, run the same command that the
installer uses. Then use `traefik,orchard` for `tenant.ingressNamespaces`.

```bash
helm repo add traefik https://traefik.github.io/charts
helm upgrade --install traefik traefik/traefik \
  --namespace traefik --create-namespace \
  --set providers.kubernetesGateway.enabled=true \
  --set gateway.enabled=false \
  --wait --timeout 10m
```

### Install the chart

**1. Create the namespaces and the Secret.** The Secret holds two values the
server needs at boot. `jwt` signs sessions and must be at least 32 characters.
`enc` encrypts stored secrets, so keep it safe: a new key makes everything already
encrypted unreadable.

```bash
kubectl create namespace orchard
kubectl create namespace network
kubectl -n orchard create secret generic orchard-secrets \
  --from-literal=jwt="$(openssl rand -base64 48 | tr -d '\n')" \
  --from-literal=enc="$(openssl rand -base64 32 | tr -d '\n')"
```

**2. Write `my-values.yaml`.** CI renders this exact file, from
`infra/charts/orchard/examples/minimal-values.yaml`, on every chart change:

```yaml
createNamespace: false
signupMode: invite_only
datadog:
  enabled: false
ingress:
  host: orchard.example.com
  tls:
    enabled: true
    issuerRef: { name: letsencrypt, kind: ClusterIssuer }
gateway:
  http:
    enabled: false
    appDomain: apps.example.com
certificates:
  enabled: false
mcp:
  enabled: false
tenant:
  storageClass: local-path
  ingressClass: traefik
  ingressNamespaces: kube-system,orchard
  cnpgOperatorNamespace: cnpg-system
  certClusterIssuer: letsencrypt
server:
  env:
    - { name: FRONTEND_URL, value: https://orchard.example.com }
    - name: JWT_SECRET
      valueFrom: { secretKeyRef: { name: orchard-secrets, key: jwt } }
    - name: SECRETS_ENCRYPTION_KEY
      valueFrom: { secretKeyRef: { name: orchard-secrets, key: enc } }
```

Replace the hostnames, then check these against your cluster:

| Value                          | What to set                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant.storageClass`          | A class from `kubectl get storageclass`, or `''` for the cluster default                                                                                                                                                                                                                                                                   |
| `tenant.ingressClass`          | A class from `kubectl get ingressclass`                                                                                                                                                                                                                                                                                                    |
| `tenant.ingressNamespaces`     | The namespace your ingress controller's pods run in, then `orchard`. The Traefik bundled with k3s runs in `kube-system`. To find the namespace, run `kubectl get pods -A -l app.kubernetes.io/name=traefik`. Tenant namespaces deny traffic by default, so with the wrong one apps are unreachable and HTTP-01 certificates are not issued |
| `tenant.cnpgOperatorNamespace` | The namespace where CloudNativePG runs, which is `cnpg-system` in the commands above. With the wrong one, the tenant network policy blocks the operator, and databases show `Instance Status Extraction Error`                                                                                                                             |
| `tenant.certClusterIssuer`     | A ClusterIssuer from `kubectl get clusterissuer`, also used in `ingress.tls.issuerRef`                                                                                                                                                                                                                                                     |
| `gateway.http.enabled`         | Leave `false`. App URLs use `Ingress`, and this listener wants a wildcard Secret nothing creates                                                                                                                                                                                                                                           |
| `certificates.enabled`         | Leave `false` unless you have a DNS-01 issuer for wildcards. The default needs one named `letsencrypt-dns01-wildcard`                                                                                                                                                                                                                      |
| `mcp.enabled`                  | Leave `false` to start. On, it needs the extra settings below                                                                                                                                                                                                                                                                              |

App pods can also open connections to the namespaces in
`tenant.ingressNamespaces`. If you list `kube-system`, this includes the pods in
`kube-system`. To keep apps away from them, turn off the bundled Traefik, install
Traefik in its own namespace, and list that namespace instead.

**3. Install and wait for the API.**

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard -f my-values.yaml
kubectl -n orchard rollout status deploy/server --timeout=10m
```

**4. Get the claim link.** The server logs one on first boot, but only once and
only on one replica, so mint one instead:

```bash
kubectl -n orchard exec deploy/server -- node dist/scripts/mint-claim-link.js
```

Keeping `createNamespace: true`, the default, makes the chart render `orchard`
and any missing `network` namespace itself, so pass `--create-namespace` and
create the Secret after the install. The server waits for it. A `network`
namespace that already exists is left alone, and one the chart made survives
`helm uninstall`.

### Upgrade the chart

To change a value or move to a new version, upgrade the release:

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard -f my-values.yaml --server-side=false
```

On Helm 4, pass `--server-side=false`. Orchard's server updates the
`buildkit-config` ConfigMap when it runs a build, so a server-side upgrade after the
first build fails with `conflict ... buildkit-config ... conflicts with unknown`.
Helm 3 does not have this flag, so leave it out. A failed upgrade can leave settings
partly applied, so run the upgrade again with the flag.

### Turn on image builds

Without a registry, a build stops with an error that names `DOCKER_REGISTRY_PUSH`
and `DOCKER_REGISTRY_PULL`. To turn on builds:

1. Add the registry to `my-values.yaml`. Builders can reach DNS and public IP
   addresses on ports 80 and 443, plus what `builders.registryEgress` lists.

   ```yaml
   builders:
     harbor:
       username: robot$orchard
       password: <registry password>
       hosts: [registry.example.com]
     registryEgress:
       - namespace: <namespace your registry runs in>
       - namespace: kube-system
         podLabels: { app.kubernetes.io/name: traefik }
   ```

   If your registry is behind an ingress in the same cluster, the second entry is
   required, with the namespace of your ingress controller. The push goes to the
   ingress controller rather than the registry pod. Without this entry, the build
   fails at the push with `dial tcp <address>:443: connection refused`. Otherwise,
   remove the entry.

2. Add these variables to `server.env`:

   ```yaml
   - { name: DOCKER_REGISTRY_PUSH, value: registry.example.com }
   - { name: DOCKER_REGISTRY_PULL, value: registry.example.com }
   - { name: REGISTRY_PROJECT, value: orchard }
   ```

3. Upgrade the chart.

4. Give every node credentials for the registry. Orchard does not add a pull secret
   to app pods for this registry, so without this step, a build succeeds and the pod
   then fails with `ErrImagePull` and `no basic auth credentials`.

   On k3s, write this file to `/etc/rancher/k3s/registries.yaml` on each node, then
   run `sudo systemctl restart k3s`:

   ```yaml
   configs:
     registry.example.com:
       auth:
         username: robot$orchard
         password: <registry password>
   ```

   On another distribution, use the registry configuration of its container runtime.

The `REGISTRY_PULL_SECRET_NAME` variable does not change how app pods pull. It names
the Secret that build jobs in the `orchard-builders` namespace use to push.

### Turn on backups

Without object storage, a backup request fails with `No backup storage`. To keep
backups in a store inside the cluster, add these values and upgrade the chart:

```yaml
objectStorage:
  local:
    enabled: true
    storage: { size: 20Gi, storageClass: local-path }
```

These are the values that the installer writes, and backups and restores were tested
through the installer. They were not tested on this path. These backups sit on the
same disk as your databases, so they do not protect you if you lose the disk. To use
external storage, refer to
[Backup storage for operators](https://docs.orchard.my/data/backups/#backup-storage-for-operators).

### Turn on MCP

Set `mcp.enabled: true` and `mcp.ingress.host`. Set `JWT_SECRET` and
`MCP_SERVICE_TOKEN` in `mcp.env`, and the same `MCP_SERVICE_TOKEN` in `server.env`.
This configuration was not tested on this path.

### More information

The chart's [`README.md`](../infra/charts/orchard/README.md) is the values
reference and troubleshooting guide.

Login options out of the box: email OTP (needs `SMTP_*` env), passkeys, and on
the superadmin a password or a printed link.

## First sign-in

A fresh instance has no accounts and no superadmin, and it very likely has no
`SMTP_*` env either, so it cannot deliver an OTP. The way in is a **claim
link**: a single-use token that creates the first account, makes it the
superadmin, creates its organization, and signs it in, all in one step.

The link is printed three ways, whichever suits you:

- in the closing box the installer prints when it finishes
- in the server log on first boot, once, on one replica
- on demand, by running `sudo orchardctl claim` on the host, or on a Helm install
  `kubectl -n orchard exec deploy/server -- node dist/scripts/mint-claim-link.js`

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

Claiming drops you into a short setup, which blocks until the instance has what
it needs to work:

1. **A way back in.** Not skippable, because the claim link only works once and
   a session that ends with nothing else locks you out. It offers a **passkey**
   where the browser allows one and a **password** where it does not, which is
   any instance served over plain HTTP. Either one satisfies the step.
2. **Your organization.** Already created for you, named after your email
   domain, because everything else in Orchard hangs off one and there is no
   self-serve way to make one. This step only renames it, so skipping is safe.
3. **Connect GitHub.** Creates the GitHub App that deploying from a repository
   needs, in one click. Skippable, and you can do it later.
4. **Certificates.** Reports how TLS is doing for your app domain. Nothing here
   is yours to do unless something failed.
5. **Anonymous usage reports.** Off unless you opt in. It shows you the exact
   report first. See [Anonymous usage reports](#anonymous-usage-reports).

The rule the gate is built on: **no skip may leave Orchard unusable**. Anything
whose absence would break the instance is either unskippable, or done for you
and demoted to customisation. It is enforced server-side, not just in the UI.

Steps are resumable, and `done` is always derived from the thing the step
produces rather than a stored flag, so removing your only way back in reopens
that step instead of leaving a stale tick behind.

### Getting back in

The claim link is one-time, so once you close that tab, a session cookie and
whatever you set up in the first step are all you have. These all work with no
email and no identity provider:

| Way in       | How                                 | Notes                                                 |
| ------------ | ----------------------------------- | ----------------------------------------------------- |
| Passkey      | Setup, or Settings                  | Needs a secure context, so a real certificate         |
| Password     | Setup, or `orchardctl password set` | Superadmin only. Running `set` again is the reset     |
| Sign-in link | `sudo orchardctl login`             | Valid ten minutes, works once. Needs root on the host |

Passkeys need no external service, and passkey sign-in needs no email address:
Orchard uses discoverable credentials, so the login page can identify you from
the authenticator alone. A browser refuses WebAuthn behind a self-signed cert,
so the instance must be serving a real certificate first. `WEBAUTHN_RP_ID`
defaults to the hostname in `FRONTEND_URL`, so there is normally nothing to
configure.

**If you lose every passkey**, `sudo orchardctl login` still gets you in, and you
can register a new one from Settings. On a cluster with no `orchardctl`, run what
it runs, adding `--email` if you are not the first superadmin:

```bash
kubectl -n orchard exec deploy/server -- node dist/scripts/mint-login-link.js
```

`sudo orchardctl claim` also mints a link after the instance has been claimed,
but only when no passkey, password, email or identity provider exists to sign in
with. Otherwise it refuses and names the one to use.

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

Email is optional for a single-operator instance. Without it an invitation still
works as a copyable link, but anyone new needs email or an identity provider to
sign in, since OTPs are delivered over it. Set
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` in
`server.env` and re-run the upgrade.

Until then, a requested OTP goes nowhere. The server only writes codes to its log
outside production, and the chart always sets `NODE_ENV=production`, so there
is nothing to find in `kubectl logs`. Use a passkey or a password instead, or print
a one-time link on the host. See [Getting back in](#getting-back-in).

Keep `signupMode: invite_only`, the chart default, which the installer sets too.
Switching to `open` on an instance that can send email turns the login page into
public registration.

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

**The address has to be the caller's, not a proxy's.** Orchard never decides
that an address is a proxy because it looks private. A header carries no proof of
who wrote it, so the only thing trusted is position, and only as far as you
declare: Orchard starts at the socket peer and walks `X-Forwarded-For` from the
right, skipping exactly the hops you configured. The first address past them is
the caller. `X-Real-IP` is never read. A pod in the cluster, or a client behind
SNAT, is therefore keyed on its own address and cannot pick another by sending
its own headers.

| Variable                | What it does                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`           | Hops to trust (`1` = one ingress, `2` = load balancer plus ingress), or a CIDR list. Unset trusts nothing. The chart and installer set `1`. |
| `TRUSTED_PROXY_RANGES`  | Extra proxy CIDRs trusted at any position, for a CDN or load balancer Orchard does not ship.                                                |
| `TRUST_CLOUDFLARE`      | `false` to stop skipping Cloudflare's published edge ranges.                                                                                |
| `CLIENT_IP_HEADER`      | Header carrying the real client address, for example `cf-connecting-ip`.                                                                    |
| `CLIENT_IP_HEADER_FROM` | CIDRs of the hop allowed to supply that header. Without a match the header is ignored.                                                      |

In chart values these are `clientIp.trustProxy`, `clientIp.trustedProxyRanges`,
`clientIp.trustCloudflare`, `clientIp.header` and `clientIp.headerFrom`.

Choose by deployment mode:

- **Public (Traefik or HAProxy directly on the internet):** `TRUST_PROXY=1`.
- **Cloudflare in front of Traefik:** `TRUST_PROXY=1`; Cloudflare's ranges are
  skipped automatically.
- **Cloudflare Tunnel:** `cloudflared` reaches Traefik from inside the cluster,
  so Traefik overwrites `X-Forwarded-For` with the cloudflared pod address. The
  installer sets `TRUST_PROXY=1`, `CLIENT_IP_HEADER=cf-connecting-ip` and
  `CLIENT_IP_HEADER_FROM` to the cluster pod CIDRs, and applies a
  NetworkPolicy so only the `cloudflared` and `orchard` namespaces can reach
  Traefik's web ports. That policy is what makes the header provable: a tenant
  pod can no longer connect to Traefik and forge it. If you run your own tunnel,
  apply an equivalent policy before setting these.
- **LAN:** `TRUST_PROXY=1`.

If your load balancer SNATs clients (some `LoadBalancer` implementations do),
every visitor arrives as the balancer's address and shares one bucket. Orchard
widens per-IP buckets for such non-public addresses and shortens their block,
and every sign-in action also has a global ceiling that only requests which
passed their own per-address and per-identity checks can spend. Crossing it never
blocks anyone: new attempts are slowed by a second or two (and Turnstile, when
configured, is already required of everyone). The real fix is `externalTrafficPolicy: Local` or the proxy protocol.

Per-IP buckets key IPv6 clients on their /64 (IPv4-mapped, 6to4 and Teredo addresses
on the IPv4 they embed), so rotating addresses inside one allocation does not buy
more attempts. When sign-up is closed or invite-only, an email code is only sent to
an address that has an account or a pending invitation; the response is identical
either way. Email codes are also capped per address and per IP per hour, and invite
emails per inviter, organization, address and instance per hour.

Attempt counters for sign-in endpoints that fall back to Postgres, one-time
codes and passkey challenges are cleaned every ten minutes by the replica holding
the cluster lease, in batches.

`CF-Connecting-IP` from Cloudflare's edge ranges is read only after an address
Cloudflare itself must have written has been seen in the chain. Restrict the
origin to your CDN's address ranges, at the load balancer or with a network
policy, so a request cannot reach it directly.

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
| `orchardctl uninstall`                            | remove Orchard, k3s and everything on them, after a typed confirmation   | yes  |

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
file rather than minting new ones. A new encryption key would make every secret
already in the database permanently undecryptable. k3s only restarts if the
registry mirror changed, so a re-run leaves your apps serving.

A re-run keeps everything else in the values file too: chart values you set with
`orchardctl config`, environment variables you set with `orchardctl env` for
`server`, `frontend` and `mcp`, and anything you edited by hand. A value changes
only when you change an answer that it depends on, on the review screen or with
a flag. For example, a new dashboard domain updates `ingress.host` and
`FRONTEND_URL`, and `signupMode` stays as it is.

The installer compares two versions of the file it would write: one from your
previous answers and one from this run's answers. Only the values that differ
replace yours. Lists other than `env` stay whole, as they do in Helm. `env` lists
merge by `name`. Settings that your file does not have yet are added, which is
how the defaults of a newer `hostDefaults` round arrive, and it also means a
setting the installer writes comes back if you removed it. If a newer release
changes a default and you set that key yourself, your value stays, and the
installer names the key.

Before it changes the file, the installer prints each setting that changes, with
the values of secrets hidden, and saves a copy as
`/etc/orchard/values.yaml.<date>-<time>.bak` with mode 600. The copy contains
your secrets, so delete it when you no longer need it. The new file can lose
comments and formatting. If no setting changes, the installer does not touch the
file.

If `yq` is missing, the file does not parse, or the merge fails, the installer
stops and does not change the file. It saves a copy first. Do not delete the
file to get past this: a new file means new secrets, and Orchard cannot read data
encrypted with the old ones.

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
`SSO_ALLOW_INTERNAL_IDP=true`. It only applies to instance identity providers:
an organization's provider is controlled by that organization, so it can never
reach internal addresses.

To provision accounts from your company directory, create an instance SCIM
token under **Admin → Sign in** and point your IdP's SCIM connector at
`https://<your-host>/apiv1/scim/instance/v2`. It creates accounts, renames
them and turns them off; deleting a user in the IdP turns the account off
rather than removing it. Which organizations and projects people reach still
comes from the instance group rules at sign-in. Organization SCIM tokens can't
be used here, and instance tokens can't be used on an organization's SCIM
endpoint.

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
(default: the platform bucket). With an upstream endpoint configured and
neither `ALLOWED_BUCKETS` nor `DEFAULT_BACKUP_BUCKET` set, the proxy refuses to
start and the chart refuses to render; an empty list never means "every
bucket". A bucket name an organization stores as its backup bucket is not
trusted by the proxy. Requests are also restricted to the operations barman
and the server use (object get/put/head/delete, list, multipart, multi-object
delete), with a canonical path and query, and `x-amz-*` headers on a short
allowlist. An organization that brought its own bucket
and keys talks to it directly and never goes through the proxy.

The proxy reads its bindings from the platform database as `orchard_r2_proxy`,
a login role the CNPG cluster manages with a password the chart keeps in the
`orchard-r2-proxy-db` secret and holds stable across upgrades. The server
grants that role `SELECT` on the three tables it needs, plus the key columns of `storage_access_keys`, at every boot. On the
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
- DNS-01 issuer credentials and wildcard issuance: see
  [Wildcard certificates](https://docs.orchard.my/operate/wildcard-certificates/). Secrets stay in your ops repo.
- Database backup schedules: CNPG `ScheduledBackup` resources are yours to
  define; the r2-proxy component brokers per-cluster credentials when
  enabled.
