# One-command install

For a single Linux box with an IPv4 address and nothing on it yet:

```bash
curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh && sudo bash orchard-install.sh
```

IPv6-only servers are not supported yet. On a server with no IPv4 address, the
installer stops before it asks anything or installs anything: GitHub and ghcr.io
have no IPv6 addresses, so it cannot download k3s or the images, and Orchard
listens on IPv4 only. Use a server with an IPv4 address. NAT64 in front of an
IPv4 server is unsupported and untested. `--allow-ipv6-only` continues anyway,
and `--yes` does not imply it. Dual-stack servers work, and they use `A` records.

Not `curl ... | sudo bash`: the installer asks questions, and a pipe takes the
standard input it would read the answers from. Download the script to a file and
run it, as above. Do not pass the script to `bash -c` either: the script is
larger than the kernel's limit for a single argument, so that form fails.
`--yes` plus the environment variables below is the non-interactive path, and
that one pipes fine.

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
| versitygw     | An S3 store on this box for database backups, checkpoints, point-in-time restore, forks and uploads        |
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

The installer asks one question at a time, and each has a default. Press Enter to accept it. It installs nothing until you confirm your answers on a review screen, where you can also change any answer or cancel.

1. **Mode**: `public`, `tunnel` or `lan`, with a recommendation from what it detects. In `tunnel` mode it also asks for the tunnel token.
2. **Public IP**: the detected address. It covers machines with several interfaces, 1:1 NAT, and none detected. `none` leaves it blank, and public ports and databases stay unavailable until you set it.
3. **Dashboard domain**: an `sslip.io` name by default in `public` mode, which needs no DNS records. All `sslip.io` users share one Let's Encrypt limit, so use it for trials only.
4. **Apps domain**: `apps.<parent of your domain>`. It needs a wildcard record.
5. **Custom domains target**: what people CNAME their own domains to. The dashboard domain by default, or `<tunnel-id>.cfargotunnel.com` in `tunnel` mode.
6. **MCP**: on or off, then its hostname, `mcp.<parent of your domain>` by default. Any name works. A name directly under the apps domain needs no record of its own, and Orchard reserves it so no app can take it.
7. **Let's Encrypt email**: optional, `public` mode only.
8. **Updates**: `manual` by default, or `automatic` for nightly.
9. **S3 storage**: optional. Refer to [S3 storage](#s3-storage).

The review screen also has resource limits. By default the setup page in the dashboard asks. Setting them here locks the value.

It then prints the DNS records to create, computed from your answers, and checks them against public resolvers. Each record shows `resolves`, `waiting`, `wrong value`, `proxied` or `not checked`, with a plain explanation of what it found. You can check again, continue anyway, skip for now, or go back and change an answer. It never waits in silence and never stops the install over DNS. The docs list each case: [Add DNS records](../apps/docs/src/content/docs/start/install.md#add-dns-records).

The summary at the end says what is configured, what is still pending, what the setup page in the dashboard will ask next, and how to change each setting later.

The public IP and the custom domains target are saved to the database, so **Instance admin** > **Configuration** can edit them. `sudo orchardctl public-ip set <ip> --apply` and `sudo orchardctl env set INGRESS_CNAME <host> --apply` pin them and lock those fields.

Every answer has a flag and an environment variable. `--yes` never prompts and never waits for DNS. It uses flags first, then current settings, then defaults, and an answer with no default stops the run and names its flag.

Running the installer again reads your current settings and goes straight to the review screen. Anything you leave alone does not change, and `--yes` keeps it too. A changed answer shows what it affects: for example, a new apps domain applies to new apps only, and deployed apps keep their URLs, including after a redeploy.

This includes everything in `/etc/orchard/values.yaml`, such as values that you set with `orchardctl config set` or `orchardctl env set`, or edited by hand. A value changes only when you change an answer that it depends on: a new dashboard domain updates `ingress.host` and `FRONTEND_URL`, and `signupMode` stays as it is. The installer also adds settings that a newer release needs and that your file does not have yet.

Before the installer changes the file, it prints each setting that changes, with the values of secrets hidden, and saves a copy as `/etc/orchard/values.yaml.<date>-<time>.bak`. Only root can read the copy. It contains your secrets, so delete it when you no longer need it. The new file can lose comments and formatting. If the installer cannot read or update the file, it stops and does not change the file.

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
- **lan**: LAN or Tailscale only, over plain HTTP. The dashboard
  answers on the box's own addresses (the Tailscale one included), its hostname
  and its `.local` name, so no DNS has to resolve for it. Generated app
  hostnames still use `sslip.io`, because a wildcard cannot hang off an IP.
  `orchardctl hostname add <name> --apply` teaches it a name it did not know
  about at install time, and `orchardctl claim --url <name>` mints a claim link
  on one

Updates are manual by default: run `sudo orchardctl update` when you want a new
version. To update nightly with a systemd timer, run the installer with
`--updates automatic`.

## S3 storage

S3 storage is optional. Database backups and uploads work without it, on this box.
If the box is lost, the backups are lost, and a fresh install also keeps a daily
dump of Orchard's own database there. `orchard up` needs S3 storage.

The installer asks one question about it. If you say yes, it asks for a provider,
region, bucket, access key and secret key, then tests the connection. A failed
test lets you retry or skip, and it never stops the install.

To answer without a prompt:

```bash
export ORCHARD_S3_SECRET_KEY='<secret key>'
sudo --preserve-env=ORCHARD_S3_SECRET_KEY ./install.sh --yes \
  --mode public --domain orchard.example.com \
  --s3-endpoint https://s3.eu-west-1.amazonaws.com \
  --s3-bucket my-orchard-bucket \
  --s3-region eu-west-1 \
  --s3-access-key <access key> \
  --no-s3-path-style
```

| Flag                                    | Environment variable         |
| --------------------------------------- | ---------------------------- |
| `--s3-endpoint <url>`                   | `ORCHARD_S3_ENDPOINT`        |
| `--s3-bucket <name>`                    | `ORCHARD_S3_BUCKET`          |
| `--s3-region <name>`                    | `ORCHARD_S3_REGION`          |
| `--s3-access-key <id>`                  | `ORCHARD_S3_ACCESS_KEY`      |
| `--s3-secret-key-file <path>`           | `ORCHARD_S3_SECRET_KEY_FILE` |
|                                         | `ORCHARD_S3_SECRET_KEY`      |
| `--s3-secret-key <secret>`              |                              |
| `--s3-path-style`, `--no-s3-path-style` | `ORCHARD_S3_PATH_STYLE`      |
| `--no-s3`                               | `ORCHARD_S3=false`           |

A secret on the command line stays in your shell history, so prefer the file or
the environment variable. Under `--yes`, a failed test prints why and carries on
without S3.

Add or change it later with `sudo orchardctl backups s3 set`, or under Instance
admin. Provider settings are at
[docs.orchard.hackclub.com/operate/storage](https://docs.orchard.hackclub.com/operate/storage/).

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

A ufw deny rule doesn't close `80` or `443`: that traffic is forwarded to pods and
passes around ufw. The installer keeps your rule and warns. To close a port, use a
firewall in front of the box.

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
60G, 50G and 50G; the log store gets a tenth, capped at 20G. The installer
refuses less than 20G of free disk and warns under 60G.

Orchard runs on 2 GiB of RAM. 8 GB is recommended. The installer never refuses
on memory: under about 2Gi it warns that apps will have little or no room, and
under 3.5Gi it warns again and uses its smallest profile.

Under 8Gi, metrics, logs and the scanner run with smaller memory requests and
limits, logs keep a week instead of two, and one scan runs at a time. Under
3.5Gi, a new install also turns MCP and image scanning off (unless you passed
`--mcp`, `--mcp-domain` or `--image-scanning`), and gives the server, frontend,
Postgres, Redis and each build smaller memory requests. The exact numbers are in
the generated values file, and `orchardctl config set` changes any of them.

## What it deliberately leaves off

**Sandboxed builds and tenant isolation.** gVisor and Kata need node-level
runtimes that vary by distro, so they are not installed. Without them, image
builds run in rootless BuildKit and share this machine's kernel, which is fine
when the person building the image owns the box. On Ubuntu 24.04 the installer
sets `kernel.apparmor_restrict_unprivileged_userns=0`, because rootless builds
need it. If strangers will push code here, install a runtime first.

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
DNS-01 issuer; see [Wildcard certificates](https://docs.orchard.hackclub.com/operate/wildcard-certificates/).

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

| Flag                             | Environment variable      | Default                                                                                     |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `--updates <manual\|automatic>`  | `ORCHARD_UPDATE_POLICY`   | `manual`                                                                                    |
| `--mcp <true\|false>`            | `ORCHARD_MCP`             | `true`. Off, no MCP is deployed and the admin panel's toggle is pinned off.                 |
| `--metrics <true\|false>`        | `ORCHARD_METRICS`         | `true`. The metrics graphs and usage pages.                                                 |
| `--logs <true\|false>`           | `ORCHARD_LOGS`            | `true`. Log search and per-route request stats.                                             |
| `--image-scanning <true\|false>` | `ORCHARD_IMAGE_SCANNING`  | `true`. Vulnerability scans of every image Orchard builds.                                  |
| `--object-storage <true\|false>` | `ORCHARD_OBJECT_STORAGE`  | `true`. The local S3 store database backups go to.                                          |
| `--limits <on\|off>`             | `ORCHARD_LIMITS`          | unset. The setup page asks. Set, it skips the question. You can change it in the dashboard. |
| `--yes`, `-y`                    | `ORCHARD_ASSUME_YES`      | `false`                                                                                     |
| `--allow-ipv6-only`              | `ORCHARD_ALLOW_IPV6_ONLY` | `false`. Continue on a server with no IPv4 address. Unsupported and untested.               |
| `--help`, `-h`                   |                           |                                                                                             |
|                                  | `NO_COLOR`                | unset. Any value disables colour.                                                           |
|                                  | `ORCHARD_NO_PACING`       | unset. `1` removes the brief pauses in the opening screen.                                  |

### Versions and images

| Flag                           | Environment variable        | Default                                         |
| ------------------------------ | --------------------------- | ----------------------------------------------- |
| `--chart <ref>`                | `ORCHARD_CHART`             | `oci://ghcr.io/hackclub/orchard/charts/orchard` |
| `--chart-version <semver>`     | `ORCHARD_VERSION`           | latest                                          |
| `--image-tag <tag>`            | `ORCHARD_IMAGE_TAG`         | unset: the chart's release versions             |
| `--image-pull-policy <policy>` | `ORCHARD_IMAGE_PULL_POLICY` | `Always`                                        |
| `--image-registry <host>`      | `ORCHARD_IMAGE_REGISTRY`    | `ghcr.io`                                       |
| `--image-repository <path>`    | `ORCHARD_IMAGE_REPOSITORY`  | `hackclub/orchard`                              |

By default the values file sets no image tag, so the server, frontend and MCP
run the versions the published chart was released with, and they move together
when `orchardctl update` installs a newer chart. A restart never changes the
version. `--image-tag` sets one tag for the server and frontend, such as
`latest` or a build of your own, and is kept on re-runs. A release version is
refused there, because the server and frontend are versioned separately: use
`--chart-version` instead. A chart from a local directory has no release
versions, so with `--chart <dir>` the tag falls back to `latest`.

Earlier installers wrote `latest`. On such a host, the next re-run or
`orchardctl update` removes those two tags once and prints the change.

### Cluster

| Flag                          | Environment variable      | Default                  |
| ----------------------------- | ------------------------- | ------------------------ |
| `--k3s-channel <channel>`     | `K3S_CHANNEL`             | `v1.36`                  |
| `--k3s-version <version>`     | `K3S_VERSION`             | none                     |
| `--gateway-api-version <ver>` | `GATEWAY_API_VERSION`     | `v1.6.1`                 |
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
