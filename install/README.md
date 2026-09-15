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

| Component     | Why                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------ |
| k3s           | The cluster. Traefik disabled (installed separately), servicelb kept                       |
| Traefik       | Control-plane ingress and the app Gateway                                                  |
| CloudNativePG | Orchard's own database and every database you create                                       |
| cert-manager  | TLS, unless Cloudflare is terminating it for you                                           |
| zot           | Registry for images Orchard builds                                                         |
| Orchard       | The Helm chart, with a generated values file, including the MCP endpoint agents connect to |

Everything lands in `/etc/orchard/values.yaml`. Edit that file and run
`orchard-update` to apply changes.

## What it asks

Two things it cannot work out on its own: your **domain**, and an **email for
Let's Encrypt**. Everything else is detected: architecture, memory, free disk,
free ports, whether you are behind NAT.

Two more hostnames are derived rather than asked for: `apps.<your domain>` for
deployed apps, and `mcp.<your domain>` for the MCP endpoint AI agents connect
to. In `public` mode both need a DNS record, and the installer prints them
before it waits. `--mcp-domain` moves the MCP, `--mcp false` leaves it out.

It then checks the MCP hostname actually resolves, and if it does not, offers to
re-check, take a different hostname, or leave the MCP off. Under `--yes` it skips
it and says so. Turning it on later is one command, and shipping an endpoint for
a name that does not exist is not: the certificate is issued over HTTP-01, so it
would retry against nothing and stay quietly broken.

`public` and `lan` mode need ports 80 and 443 free; `tunnel` mode binds neither.
In `public` mode, 80 carries the Let's Encrypt HTTP-01 challenge for every
hostname including each new app, at issue and at every renewal, and the ACME
spec fixes that port. In `lan` mode there is no TLS on the dashboard, so 80 is
simply where it is served, and 443 carries deployed apps on self-signed
certificates. The installer reports what holds them during its first step and
stops only if the mode you choose needs them.

amd64 only for now. Image builds target `linux/amd64`, so the installer refuses
to run on anything else rather than leave you with apps that cannot start.

Run it on a real machine or VM. Inside a Docker container k3s cannot nest its
overlayfs snapshotter, and under CPU emulation seccomp is unavailable, so the
kubelet never creates a pod sandbox.

It also asks how traffic should reach the box:

- **public**: you have a routable IP; point DNS at it and Let's Encrypt issues
  certificates over HTTP-01
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

And whether updates are **manual** (`orchard-update` when you want them) or
**automatic** (a nightly systemd timer).

## Claiming the instance

A fresh install has no superadmin. On first boot the server mints a single-use
setup token, valid for 24 hours, and logs the URL that redeems it:

```bash
kubectl -n orchard logs deploy/server | grep -A2 'no superadmin'
```

Sign up with the account you want to own the instance, open that URL, and the
token is consumed. If it expires, restart the server to mint a new one.

## Sizing

Build concurrency, cache size and registry size are derived from the machine:

| RAM    | Concurrent builds |
| ------ | ----------------- |
| < 8Gi  | 1                 |
| 8–16Gi | 2                 |
| > 16Gi | 3                 |

Build cache and registry each get a fifth of the free disk, capped at 60G and
50G. The floor is 4Gi RAM and 20G disk; 8Gi and 60G is comfortable.

## What it deliberately leaves off

**Sandboxed builds and tenant isolation.** gVisor and Kata need node-level
runtimes that vary by distro, so they are not installed. Without them, image
builds run with host-level privileges, the same posture as Docker-based
platforms, and fine when the person building the image owns the box.

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

**Multi-node.** One box only. For multiple nodes, use the Helm chart.

**Custom ports.** `--http-port` and `--https-port` move Traefik off 80 and 443,
and only `lan` mode accepts them. `public` needs 80 for the ACME HTTP-01
challenge and 443 for browsers; `tunnel` binds neither. The ports are written
into the server environment as `PUBLIC_HTTP_PORT` and `PUBLIC_HTTPS_PORT`, so
the `url` the API returns for every ingress carries them and the dashboard, CLI
and TUI all link correctly.

**Wildcard certificates.** Apps get per-hostname certificates. Wildcards need a
DNS-01 issuer; see [SETUP-wildcards.md](../infra/charts/orchard/SETUP-wildcards.md).

**Public TCP/UDP in tunnel mode.** Cloudflare Tunnels carry HTTP only, so
publicly exposed databases and raw ports are unavailable there.

**A default public IP.** Raw ports and public databases are published on an
external address, and the installer does not assume this box's is the right one.
Set it once and every organization inherits it, rather than each being asked for
an address they have no way to know:

```bash
sudo orchardctl public-ip set 203.0.113.10 --apply
```

## Running it non-interactively

Nothing prompts when every answer is supplied. Each flag has an environment
variable equivalent, and **flags win over environment variables**. Run
`./install.sh --help` for the same list at the terminal.

`--yes` is what suppresses the prompts. Without it the installer still asks, it
just pre-fills what you gave it.

```bash
sudo ./install.sh --yes \
  --mode public \
  --domain orchard.example.com \
  --app-domain apps.example.com \
  --email me@example.com \
  --updates manual
```

### How traffic gets in

| Flag                           | Environment variable   | Meaning                                                                  |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `--mode <public\|tunnel\|lan>` | `ORCHARD_INGRESS_MODE` | How the internet reaches this box. Detected if omitted.                  |
| `--domain <host>`              | `ORCHARD_DOMAIN`       | Where the Orchard UI lives. Defaults to this box's own IP in `lan` mode. |
| `--app-domain <host>`          | `ORCHARD_APP_DOMAIN`   | Wildcard parent for deployed apps. Defaults to `apps.<your domain>`.     |
| `--mcp-domain <host>`          | `ORCHARD_MCP_DOMAIN`   | Where agents connect over MCP. Defaults to `mcp.<your domain>`.          |
| `--email <address>`            | `ORCHARD_ACME_EMAIL`   | Let's Encrypt contact. Required in `public` mode.                        |
| `--tunnel-token <token>`       | `ORCHARD_TUNNEL_TOKEN` | Cloudflare Tunnel token. Required in `tunnel` mode.                      |

### Behaviour

| Flag                            | Environment variable    | Default                                                                     |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `--updates <manual\|automatic>` | `ORCHARD_UPDATE_POLICY` | asks; `manual` under `--yes`                                                |
| `--mcp <true\|false>`           | `ORCHARD_MCP`           | `true`. Off, no MCP is deployed and the admin panel's toggle is pinned off. |
| `--yes`, `-y`                   | `ORCHARD_ASSUME_YES`    | `false`                                                                     |
| `--help`, `-h`                  |                         |                                                                             |
|                                 | `NO_COLOR`              | unset. Any value disables colour.                                           |
|                                 | `ORCHARD_NO_PACING`     | unset. `1` removes the brief pauses in the opening screen.                  |

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
| `--registry-port <port>`      | `ORCHARD_ZOT_NODE_PORT`   | `30100`                  |
| `--registry-host <host>`      | `ORCHARD_REGISTRY_HOST`   | `registry.orchard.local` |
| `--state-dir <path>`          | `ORCHARD_STATE_DIR`       | `/etc/orchard`           |

The node port range is what your apps can claim, so it is also the range you
forward on a router. The registry port must sit inside it; the installer refuses
to start if it does not.

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
