# One-command install

For a single Linux box with nothing on it yet:

```bash
sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)"
```

Not `curl ... | sudo bash`: the installer asks questions, and a pipe takes the
standard input it would read the answers from. `bash -c "$(...)"` keeps your
terminal attached. `--yes` plus the environment variables below is the
non-interactive path, and that one pipes fine.

This is the amateur-friendly path. It creates its own k3s cluster and installs
everything Orchard needs. If you already run Kubernetes, do **not** use this.
Install the Helm chart instead and keep your own platform layer
([docs/self-hosting.md](../docs/self-hosting.md)).

## What it installs

| Component     | Why                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| k3s           | The cluster. Traefik disabled (installed separately), servicelb kept                                       |
| Traefik       | Control-plane ingress and the app Gateway                                                                  |
| CloudNativePG | Orchard's own database and every database you create                                                       |
| cert-manager  | TLS, unless Cloudflare is terminating it for you                                                           |
| zot           | Registry for images Orchard builds                                                                         |
| Orchard       | The Helm chart, with a generated values file, including the MCP endpoint agents connect to                 |
| Observability | VictoriaMetrics for the metrics graphs, VictoriaLogs and Vector for log search and per-route request stats |
| Trivy         | The Orchard image scanner behind each app's Security tab, scanning straight from zot                       |
| versitygw     | An S3 store on this box for database backups, checkpoints, point-in-time restore and forks                 |
| r2-proxy      | Hands each database credentials for its own backups only, never the store's root key                       |

Everything lands in `/etc/orchard/values.yaml`. Edit that file and run
`orchard-update` to apply changes. Environment variables are one list in that
file, holding the instance's secrets, so change them one at a time with
`sudo orchardctl env set <NAME> <value>` rather than by hand.

An instance installed before a feature was on by default gets it on its next
`sudo orchardctl update`: metrics, the log store (on `local-path`), the image
scanner, local backup storage when none is configured, and Traefik's JSON
access log. Each change is printed, only settings missing from the values file
are filled in, and it happens once, so turning something back off sticks.

## What it asks

The installer asks how traffic reaches the machine and, outside `lan` mode, which domain to use. In `tunnel` mode it also asks for the tunnel token. It works out everything else: architecture, memory, free disk, free ports, and whether the machine is behind NAT.

To try Orchard before you point a domain at the machine, select `public` mode and press Enter at the domain question. The installer then uses an `sslip.io` name for this IP address, and you do not need to add DNS records. Use this for trials only. Let's Encrypt limits the certificates issued for each registered domain, and `sslip.io` is not on the Public Suffix List, so all its users share one limit. Its operators report a raised limit of 250,000 certificates, and they also say that requests can be rate limited. If the limit applies, the dashboard shows a browser warning until cert-manager succeeds on a later retry, and the installer reports this when it finishes. A self-signed certificate is not the default, because browsers refuse passkeys on one and MCP clients refuse to connect.

To move to your own domain later, run the installer again with `--domain orchard.example.com`. It updates the dashboard URL, the app domain, and the MCP hostname. Apps that you already deployed keep their `sslip.io` URLs.

The installer sets these values for you:

| Value                 | Default                                                                                           | To change it          |
| --------------------- | ------------------------------------------------------------------------------------------------- | --------------------- |
| App domain            | `apps.<parent of your domain>`                                                                    | `--app-domain`        |
| MCP hostname          | `mcp.<app domain>`, which the wildcard record for your apps covers, so it needs no record         | `--mcp-domain`        |
| Update policy         | `manual`                                                                                          | `--updates automatic` |
| Let's Encrypt contact | None. Let's Encrypt stopped sending expiry emails in June 2025, and cert-manager does not need it | `--email`             |
| Public IP             | This IP address, in `public` mode on a machine with a routable address                            | The admin panel       |
| Custom domain target  | The dashboard domain in `public` mode. Refer to the note on `tunnel` mode below                   | `INGRESS_CNAME`       |

In `tunnel` mode, the custom domain target is `<tunnel-id>.cfargotunnel.com`, read from the tunnel token. Each custom domain also needs a route in the tunnel, and Cloudflare hides proxied records, so Orchard can confirm only that the hostname resolves.

To change the public IP, go to **Instance admin** > **Configuration** > **Public exposure**. The field stays editable. `sudo orchardctl public-ip set <ip> --apply` pins the value and locks the field.

Running the installer again reads `/etc/orchard/values.yaml` first, so it keeps your ingress mode, domains, MCP hostname, secrets, and update policy, and does not ask for them. A flag changes only the setting it names.

`public` and `lan` mode need ports 80 and 443 free; `tunnel` mode binds neither.
In `public` mode, 80 carries the Let's Encrypt HTTP-01 challenge for every
hostname including each new app, at issue and at every renewal, and the ACME
spec fixes that port. In `lan` mode there is no TLS on the dashboard, so 80 is
simply where it is served, and 443 carries deployed apps on self-signed
certificates. The installer reports what holds them during its first step and
stops only if the mode you choose needs them.

amd64 or arm64. Apps are built for whichever the machine is, and anything else
is refused.

Run it on a real machine or VM. Inside a Docker container k3s cannot nest its
overlayfs snapshotter, and under CPU emulation seccomp is unavailable, so the
kubelet never creates a pod sandbox.

It also asks how traffic should reach the box:

- **public**: you have a routable IP. Let's Encrypt issues certificates over
  HTTP-01. A domain is optional
- **tunnel**: Cloudflare Tunnel, for boxes behind NAT or CGNAT. Cloudflare
  terminates TLS, so cert-manager is skipped entirely, Traefik stays on a
  ClusterIP, and nothing binds a port on the host. This is also the answer when
  something else on the box already owns 80 or 443
- **lan**: LAN or Tailscale only, self-signed certificates. The dashboard
  answers on the box's own addresses (the Tailscale one included), its hostname
  and its `.local` name, so no DNS has to resolve for it. Generated app
  hostnames still use `sslip.io`, because a wildcard cannot hang off an IP.
  `orchardctl hostname add <name> --apply` teaches it a name it did not know
  about at install time, and `orchardctl claim --url <name>` mints a claim link
  on one

Updates are manual by default: run `sudo orchardctl update` when you want a new
version. To update nightly with a systemd timer, run the installer with
`--updates automatic`.

## Claiming the instance

A fresh install has no superadmin. On first boot the server mints a single-use
setup token, valid for 24 hours. The installer prints the link when it finishes,
and on the host you can mint a fresh one any time before you have a way to sign in:

```bash
sudo orchardctl claim
```

On a cluster with no `orchardctl`, the first boot logs it:

```bash
kubectl -n orchard logs deploy/server | grep -A3 'no superadmin'
```

Open the link. It asks only for the email address the account should use, sends
no confirmation, and makes that account the superadmin. Then a short setup runs:

1. **A way back in**, which cannot be skipped: a passkey, or a password on an
   instance served over plain HTTP, where a browser will not offer passkeys.
2. **An organization name.** One already exists, named after your email domain.
3. **Connect GitHub**, which creates the app that deploying from a repository
   needs. Skippable.
4. **Certificates**, only if a wildcard certificate failed to issue.
5. **Anonymous usage reports**, off unless you opt in.

With no SMTP and no TLS there is neither an emailed code nor a passkey to sign
in with afterwards. Two host commands cover that, and neither needs either:

```bash
sudo orchardctl login           # a one-time sign-in link, valid ten minutes
sudo orchardctl password set    # a password on the superadmin account
```

## What the box listens on

The installer opens these itself when ufw or firewalld is active, and prints a
note when neither is. If something else fronts the box, a cloud firewall or a
router, this is the list to allow.

| Port          | Bound to        | What                              | Who needs it                                 |
| ------------- | --------------- | --------------------------------- | -------------------------------------------- |
| `80`, `443`   | every interface | Traefik: the dashboard and apps   | everyone, in `public` and `lan` mode         |
| `30000-30100` | every interface | raw TCP/UDP ports apps claim      | whoever those apps serve; unused in `tunnel` |
| `6443`        | every interface | the Kubernetes API                | `kubectl` from your LAN or Tailscale only    |
| `5000`        | `127.0.0.1`     | the image registry, password only | nobody outside the box                       |
| `10250`       | every interface | the kubelet                       | nothing off the box; needs a client cert     |

Nothing else is meant to be reachable. In `tunnel` mode only `6443` and `10250`
are bound at all. The pod and service networks, `10.42.0.0/16` and
`10.43.0.0/16`, must be allowed to reach the host: that is how every pod talks
to the API, and a firewall that drops it makes the whole cluster time out after
the next reboot.

Installs from before this list existed had the registry on a node port with no
password. `sudo orchardctl update` fixes that on its way through, and
`sudo orchardctl harden` does the same without upgrading anything.

## Sizing

Build concurrency, cache size and registry size are derived from the machine:

| RAM    | Concurrent builds |
| ------ | ----------------- |
| < 8Gi  | 1                 |
| 8–16Gi | 2                 |
| > 16Gi | 3                 |

Build cache, registry and backups each get a fifth of the free disk, capped at
60G, 50G and 50G; the log store gets a tenth, capped at 20G. The floor is 4Gi
RAM and 20G disk; 8Gi and 60G is comfortable.

Nothing is switched off to fit a small box. Under 8Gi, metrics, logs and the
scanner run with smaller memory requests and limits, logs keep a week instead
of two, and one scan runs at a time. The exact numbers are in the generated
values file, and `orchardctl config set` changes any of them.

## What it deliberately leaves off

**Sandboxed builds and tenant isolation.** gVisor and Kata need node-level
runtimes that vary by distro, so they are not installed. Without them, image
builds run with host-level privileges, the same posture as Docker-based
platforms, and fine when the person building the image owns the box. Be clear
about what that means before you let anyone else deploy: a `RUN` line in a
Dockerfile is root on this machine, and the registry password sits on the
same node. If strangers will push code here, install a runtime first.

If you are running other people's code and want isolation, install the runtime
yourself, then flip the matching flag in `/etc/orchard/values.yaml` and run
`orchard-update`:

```yaml
tenantSandbox: # gVisor for tenant app pods
  enabled: true
  runtimeClassName: gvisor
builderSandbox: # Kata VMs for build jobs
  enabled: true
  runtimeClassName: kata
```

**Off-box backups.** Database backups go to an S3 store on this same machine.
That undoes a bad migration or a dropped table, but it is not disaster recovery:
lose the disk and the backups go with it. Point the instance at real S3 or R2
for that; "Moving backups to real S3 or R2" in
[the chart README](../infra/charts/orchard/README.md) walks through it, including
copying what is already there. `--object-storage false` installs without the
local store, and then backups are off until you configure storage.

**Multi-node.** One box only. For multiple nodes, use the Helm chart.

**Custom ports.** `--http-port` and `--https-port` move Traefik off 80 and 443,
and only `lan` mode accepts them. `public` needs 80 for the ACME HTTP-01
challenge and 443 for browsers; `tunnel` binds neither. The ports are written
into the server environment as `PUBLIC_HTTP_PORT` and `PUBLIC_HTTPS_PORT`, so
the `url` the API returns for every ingress carries them and the dashboard, CLI
and TUI all link correctly.

**Wildcard certificates.** Apps get per-hostname certificates. Wildcards need a
DNS-01 issuer; see [Wildcard certificates](https://docs.orchard.my/operate/wildcard-certificates/).

**Public TCP/UDP in tunnel mode.** Cloudflare Tunnels carry HTTP only, so
publicly exposed databases and raw ports are unavailable there.

## Running it non-interactively

Nothing prompts when `--yes` is set. Each flag has an environment
variable equivalent, and **flags win over environment variables**. Run
`./install.sh --help` for the same list at the terminal.

Taking the box down for a while is `sudo orchardctl stop`, and `sudo orchardctl
start` brings it back. That stops k3s, so it takes deployed apps with it;
nothing is deleted and nothing needs redeploying afterwards.

`--yes` is what suppresses the prompts. Without it the installer still asks, it
just pre-fills what you gave it.

```bash
sudo ./install.sh --yes \
  --mode public \
  --domain orchard.example.com
```

### How traffic gets in

| Flag                           | Environment variable   | Meaning                                                                                                              |
| ------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--mode <public\|tunnel\|lan>` | `ORCHARD_INGRESS_MODE` | How the internet reaches this box. Detected if omitted.                                                              |
| `--domain <host>`              | `ORCHARD_DOMAIN`       | Where the Orchard UI lives. Defaults to this box's own IP in `lan` mode, and to an `sslip.io` name in `public` mode. |
| `--app-domain <host>`          | `ORCHARD_APP_DOMAIN`   | Wildcard parent for deployed apps. Defaults to `apps.<parent of your domain>`.                                       |
| `--mcp-domain <host>`          | `ORCHARD_MCP_DOMAIN`   | Where agents connect over MCP. Defaults to `mcp.<app domain>`.                                                       |
| `--email <address>`            | `ORCHARD_ACME_EMAIL`   | Let's Encrypt contact. Optional.                                                                                     |
| `--tunnel-token <token>`       | `ORCHARD_TUNNEL_TOKEN` | Cloudflare Tunnel token. Required in `tunnel` mode.                                                                  |

### Behaviour

| Flag                             | Environment variable     | Default                                                                     |
| -------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `--updates <manual\|automatic>`  | `ORCHARD_UPDATE_POLICY`  | `manual`                                                                    |
| `--mcp <true\|false>`            | `ORCHARD_MCP`            | `true`. Off, no MCP is deployed and the admin panel's toggle is pinned off. |
| `--metrics <true\|false>`        | `ORCHARD_METRICS`        | `true`. The metrics graphs and usage pages.                                 |
| `--logs <true\|false>`           | `ORCHARD_LOGS`           | `true`. Log search and per-route request stats.                             |
| `--image-scanning <true\|false>` | `ORCHARD_IMAGE_SCANNING` | `true`. Vulnerability scans of every image Orchard builds.                  |
| `--object-storage <true\|false>` | `ORCHARD_OBJECT_STORAGE` | `true`. The local S3 store database backups go to.                          |
| `--yes`, `-y`                    | `ORCHARD_ASSUME_YES`     | `false`                                                                     |
| `--help`, `-h`                   |                          |                                                                             |
|                                  | `NO_COLOR`               | unset. Any value disables colour.                                           |
|                                  | `ORCHARD_NO_PACING`      | unset. `1` removes the brief pauses in the opening screen.                  |

### Versions and images

| Flag                           | Environment variable        | Default                                         |
| ------------------------------ | --------------------------- | ----------------------------------------------- |
| `--chart <ref>`                | `ORCHARD_CHART`             | `oci://ghcr.io/hackclub/orchard/charts/orchard` |
| `--chart-version <semver>`     | `ORCHARD_VERSION`           | latest                                          |
| `--image-tag <tag>`            | `ORCHARD_IMAGE_TAG`         | `latest`                                        |
| `--image-pull-policy <policy>` | `ORCHARD_IMAGE_PULL_POLICY` | `Always`                                        |
| `--image-registry <host>`      | `ORCHARD_IMAGE_REGISTRY`    | `ghcr.io`                                       |
| `--image-repository <path>`    | `ORCHARD_IMAGE_REPOSITORY`  | `hackclub/orchard`                              |

The image tag is pinned rather than inherited from the chart's `appVersion`,
because the server and the frontend are versioned independently and one
`appVersion` cannot name both.

### Cluster

| Flag                          | Environment variable      | Default                  |
| ----------------------------- | ------------------------- | ------------------------ |
| `--k3s-version <version>`     | `K3S_VERSION`             | `v1.31.5+k3s1`           |
| `--gateway-api-version <ver>` | `GATEWAY_API_VERSION`     | `v1.2.1`                 |
| `--node-port-range <lo-hi>`   | `ORCHARD_NODE_PORT_RANGE` | `30000-30100`            |
| `--registry-port <port>`      | `ORCHARD_REGISTRY_PORT`   | `5000`                   |
| `--registry-host <host>`      | `ORCHARD_REGISTRY_HOST`   | `registry.orchard.local` |
| `--state-dir <path>`          | `ORCHARD_STATE_DIR`       | `/etc/orchard`           |

The node port range is what your apps can claim, so it is also the range you
forward on a router. The registry port is bound to loopback only and must sit
outside the range; the installer refuses to start if it does not.

## Seeing what an install looks like

`./demo.sh` runs the installer's real interface against fake work. It touches
nothing, so it is safe anywhere:

```bash
./demo.sh                     # the happy path, roughly a minute
DEMO_SPEED=4 ./demo.sh        # four times faster
DEMO_FAIL=cert-manager ./demo.sh   # watch a step fail
```

It sources `install.sh` for its rendering rather than copying it, so what you
see is what a real install prints.
