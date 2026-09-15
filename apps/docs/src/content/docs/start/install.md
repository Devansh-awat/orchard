---
title: Install
description: One command on a fresh Linux box, or the Helm chart on a cluster you already run.
sidebar:
  order: 2
---

There are two paths, and picking the wrong one causes most install problems.

- **A bare Linux box with nothing on it** → the one-command installer below. It
  brings its own k3s.
- **A cluster you already operate** → the Helm chart. Do _not_ run the installer
  on an existing cluster; it will try to install k3s underneath you.

You can also [hand the installer to an agent](#hand-it-to-an-agent) rather than
driving it yourself.

## A bare Linux box

```bash
sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)"
```

It installs k3s, Traefik, CloudNativePG, cert-manager, a `zot` registry for the
images it builds, and Orchard itself.

**Run it that way round, not `curl ... | sudo bash`.** The installer asks a few
questions, and piping it into `bash` leaves the questions with nowhere to read
your answer from: `bash` is already using its standard input to read the script,
and on hosts where `sudo` gives the command its own pseudo-terminal your typing
never reaches it. `bash -c "$(...)"` keeps your terminal attached. If you would
rather not hand a script to `sudo` sight unseen, download it, read it, then run
it:

````bash
curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh
less orchard-install.sh
sudo bash orchard-install.sh
``` Everything it generates lands in
`/etc/orchard/values.yaml`; edit that file and run `orchard-update` to apply
changes.

**amd64 only.** Image builds target `linux/amd64`, so the installer refuses to
run on other architectures rather than leaving you with apps that cannot start.

**Run it on a real machine or VM,** not inside a Docker container: k3s cannot
nest its overlayfs snapshotter there, and under CPU emulation seccomp is
unavailable, so the kubelet never creates a pod sandbox.

### Ports 80 and 443

Which ports get bound on the host, and what for:

| mode     | port 80                                                                                                                | port 443                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `public` | Let's Encrypt HTTP-01 challenges: the dashboard, the MCP endpoint, and every app hostname, at issue and at every renewal | everything, the dashboard and apps alike       |
| `lan`    | the dashboard and the MCP endpoint, in plain HTTP, since there is no TLS to terminate                                    | deployed apps, on self-signed certificates     |
| `tunnel` | nothing binds it                                                                                                       | nothing binds it                               |

Port 80 in `public` mode is the one that cannot be negotiated. The ACME spec
fixes the HTTP-01 challenge at port 80, so it is not an Orchard default you can
change, and it is not only needed during the install: every app that gets a new
hostname, and every renewal roughly every 60 days, needs it again.

`tunnel` mode is the way out if something else on the box owns those ports.
Cloudflare terminates TLS and `cloudflared` dials out from inside the cluster, so
Traefik runs on a ClusterIP and nothing binds a host port at all. The installer
checks both ports in its first step, names the process holding them, and only
refuses if the mode you pick needs them.

### Custom ports, `lan` only

If the box needs to keep 80 or 443 for something else, `lan` mode can serve
somewhere else entirely:

```bash
sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)" -- \
  --mode lan --http-port 8080 --https-port 8443
```

The dashboard then lives at `http://<host>:8080` and apps at
`https://<app-host>:8443`. Traefik matches on the hostname and ignores the port,
so routing is unaffected, and the dashboard's own links carry the port.

`public` and `tunnel` reject these flags rather than accepting them and
misbehaving: `public` cannot move off 80 without giving up HTTP-01, and `tunnel`
binds no host port for them to change.

The port reaches clients through the API rather than through their own
guesswork: every ingress the API returns carries a `url` the server computed
from `PUBLIC_HTTP_PORT` / `PUBLIC_HTTPS_PORT`, which the installer writes into
the server and frontend environments. The dashboard, `orchard open`, `orchard
up` and the TUI all use it.

### What it asks

Two things it cannot work out on its own: your **domain**, and an **email for
Let's Encrypt**. Architecture, memory, free disk, free ports and whether you are
behind NAT are all detected.

It derives two more hostnames from your domain rather than asking: `apps.` for
deployed apps, and `mcp.` for the [MCP endpoint](/mcp/) agents connect to. In
`public` mode both need a DNS record, and the installer prints them. Move the MCP
with `--mcp-domain`, or leave it out entirely with `--mcp false`.

Before it deploys anything it checks that the MCP hostname resolves, and if it
does not, it asks:

````

! mcp.example.com does not resolve yet.
That is where AI agents connect over MCP. Its certificate is issued
over HTTP-01, so it cannot be obtained until the name points here.

What would you like to do?

1. I have added the record now, check again
2. use a different hostname
3. skip the MCP for now, I will turn it on later

````

Skipping is safe and reversible: add the record whenever you like and run
`sudo orchardctl mcp enable --apply`. Under `--yes` there is nobody to ask, so it
skips and says so. It never ships an endpoint for a hostname that does not
exist, because a certificate that cannot be issued fails quietly rather than
loudly.

It also asks how traffic reaches the box:

| Mode     | For                                        | TLS                                            |
| -------- | ------------------------------------------ | ---------------------------------------------- |
| `public` | A routable IP, DNS pointed at it           | Let's Encrypt over HTTP-01                     |
| `tunnel` | Behind NAT or CGNAT, via Cloudflare Tunnel | Cloudflare terminates it, cert-manager skipped |
| `lan`    | LAN or Tailscale only, reached by address  | Self-signed                                    |

### What `lan` mode is reachable at

The dashboard lives on the box's own address, so nothing has to resolve for it
to work: `http://192.168.4.27`, plus every other address the machine had at
install time (the Tailscale one included), its hostname, its `.local` name, and
an `orchard.<ip>.sslip.io` name for good measure. Traefik matches the `Host`
header against all of them.

That matters because `sslip.io` is **public DNS** that maps a name back to the
address inside it. Nothing is exposed by using it, since the address is a
private one either way, but it does mean a resolver has to answer, and
Tailscale's will not always answer for a private address. An install whose only
name was a `sslip.io` one was unreachable exactly when you needed it.

Apps are the exception: a wildcard cannot hang off an IP, so generated app
hostnames stay on `apps.<ip>.sslip.io`. Pass `--app-domain` to use a wildcard
you control instead.

Reached it by a name nobody knew about at install time? Add it:

```bash
sudo orchardctl hostname add mango --apply
sudo orchardctl claim --url mango
```

### Over Tailscale

A `lan` install is the right mode for a box you reach over Tailscale: nothing is
published, and WireGuard is already encrypting the hop, which is what makes
plain HTTP on the dashboard reasonable there.

Check what actually resolves before choosing a name. MagicDNS gives a machine
both a short name and a fully qualified one, and the short one only resolves
where the search domain is applied:

```bash
tailscale status
tailscale ip -4
```

The installer picks up the Tailscale address by itself, because it takes every
global IPv4 the machine has. The names are the part it cannot guess:

```bash
sudo orchardctl hostname add mango --apply
sudo orchardctl hostname add mango.tailnet-name.ts.net --apply
```

To make one of them the name links are generated with, rather than one more
name that works, change the primary and the URL the server hands out together.
They are separate values and a mismatch is the confusing case: the dashboard
answers, and every link it prints points somewhere else.

```bash
sudo yq -i '.ingress.host = "mango" |
  (.server.env[] | select(.name == "FRONTEND_URL")).value = "http://mango:8081"' \
  /etc/orchard/values.yaml

sudo orchardctl update
sudo orchardctl claim
```

`yq` is already on the box, installed alongside everything else. Use the port
the instance serves on, which is 80 unless you moved it. `orchardctl config set`
handles `ingress.host` on its own, but not `FRONTEND_URL`, which lives in a
list of `{name, value}` entries rather than at a dotted path.

To confirm what Traefik is matching on:

```bash
sudo kubectl -n orchard get ingressroute orchard \
  -o jsonpath='{.spec.routes[*].match}'
```

And whether updates are **manual** (`orchard-update` when you want them) or
**automatic** (a nightly systemd timer).

### Unattended

Every prompt has an environment variable:

```bash
ORCHARD_ASSUME_YES=true \
ORCHARD_DOMAIN=orchard.example.com \
ORCHARD_APP_DOMAIN=apps.example.com \
ORCHARD_ACME_EMAIL=me@example.com \
ORCHARD_INGRESS_MODE=public \
ORCHARD_UPDATE_POLICY=manual \
  sudo -E bash install.sh
````

Others: `ORCHARD_VERSION`, `ORCHARD_CHART`, `ORCHARD_IMAGE_REGISTRY`,
`ORCHARD_IMAGE_REPOSITORY`, `ORCHARD_STATE_DIR`, `ORCHARD_NODE_PORT_RANGE`,
`ORCHARD_ZOT_NODE_PORT`, `ORCHARD_REGISTRY_HOST`, `ORCHARD_TUNNEL_TOKEN`,
`ORCHARD_MCP`, `ORCHARD_MCP_DOMAIN`, `K3S_VERSION`, `GATEWAY_API_VERSION`.

### Hand it to an agent

The installer is a single command with an environment variable for every
prompt, which makes it something you can delegate. Give an agent SSH on the box
and this page, and it can do the whole thing.

Point it at the markdown rather than pasting instructions, so it can re-read
what it needs:

```
Install Orchard on <host> following https://docs.orchard.my/start/install.md
My domain is example.com and my email is me@example.com.
Ask me before anything that is not reversible.
```

Four things it cannot work out on its own, so decide them first or expect to be
asked:

| Decision                  | Why it is yours                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `public`, `tunnel`, `lan` | It can detect NAT, not whether you intend to expose this box                                  |
| The domain                | Nothing on the box knows what you own                                                         |
| The DNS records           | It probably has no access to your DNS provider, and the records must exist **before** the run |
| Whether to proceed        | Installs k3s system-wide, and outside `tunnel` mode takes over ports 80 and 443               |

Three things to make sure it gets right, because each fails in a way that is
quiet rather than loud:

- **amd64 and a real machine.** The installer refuses other architectures, and
  k3s cannot nest inside a Docker container. An agent that decides to "try it
  in a container anyway" produces a cluster whose kubelet never starts a pod.
- **DNS first.** In `public` mode the certificates are issued over HTTP-01, so
  a record that does not exist yet means a certificate that never arrives. The
  installer prints the records and waits.
- **`--yes` skips the questions, not the requirements.** Unattended, a missing
  MCP record leaves the MCP off rather than prompting, and the run reports it.

At the end it prints a **claim link**. That link is the credential: single use,
and it signs in as the instance superadmin. Treat it like a password, and open
it yourself rather than letting the agent follow it. If it is lost or used,
`sudo orchardctl claim` mints another.

Once you are in, the agent can drive the instance it just built over
[Orchard's own MCP](/mcp/), which the installer publishes at
`mcp.<your domain>`.

### Sizing

Build concurrency, cache size and registry size are derived from the machine:

| RAM       | Concurrent builds |
| --------- | ----------------- |
| under 8Gi | 1                 |
| 8 to 16Gi | 2                 |
| over 16Gi | 3                 |

Build cache and registry each take a fifth of free disk, capped at 60G and 50G.
The floor is 4Gi RAM and 20G disk; 8Gi and 60G is comfortable.

### What the installer leaves off

**Sandboxed builds and tenant isolation.** gVisor and Kata need node-level
runtimes that vary by distro. Without them, image builds run with host-level
privileges, the same posture as Docker-based platforms, which is fine when the
person building the image owns the box. If you run other people's code, install
the runtime yourself and flip the flag in `/etc/orchard/values.yaml`:

```yaml
tenantSandbox: # gVisor for tenant app pods
  enabled: true
  runtimeClassName: gvisor
builderSandbox: # Kata VMs for build jobs
  enabled: true
  runtimeClassName: kata
```

**DNS.** You point the records at the box; the installer only checks them. Once
it is up, **Instance admin → Networking** shows what resolves where, and if you
are behind a Cloudflare Tunnel it can add the routes for you. See
[Point DNS at this instance](/operate/finishing-setup/#point-dns-at-this-instance).

**A default public IP.** Raw TCP and UDP ports and public databases are
published on an external address, and the installer does not assume this box's
is the right one. Set it once with
`sudo orchardctl public-ip set <ip> --apply` and every organization inherits it;
see [Set a default public IP](/operate/finishing-setup/#set-a-default-public-ip).

**Multi-node**, **wildcard certificates**, and **public TCP/UDP in tunnel mode**
are also out of scope for the installer. See the chart for those.

:::caution
Deployments are network-isolated from each other and from the platform by
default, but they share the host kernel unless you install gVisor or Kata and
turn them on. Running code you do not trust is not safe without that. See
[Security and isolation](/operate/security/).
:::

## An existing cluster

Orchard deploys via the Helm chart. The chart installs Orchard's own components
and **no cluster operators**: you bring the platform layer below it.

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard --create-namespace \
  -f my-values.yaml
```

### Prerequisites

| Component                    | Needed for                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| CloudNativePG operator       | The control-plane database and every database users create                 |
| Traefik with Gateway API     | Control-plane ingress and app routing (`HTTPRoute` via a shared `Gateway`) |
| cert-manager                 | TLS, plus a DNS-01 `ClusterIssuer` for wildcard certificates               |
| A default StorageClass       | Postgres volumes, build cache, Redis, metrics                              |
| An OCI registry              | Where built images are pushed and pulled                                   |
| An ingress controller        | Custom-domain ingresses for user apps                                      |
| L4 LoadBalancer              | Only for public database exposure and TCP/UDP passthrough                  |
| gVisor / Kata RuntimeClasses | Optional, for sandboxed tenant and builder pods                            |

### DNS

You need domains you control:

- **App domain** (`APP_DOMAIN`): wildcard DNS pointing at your Gateway's
  LoadBalancer IP, plus a wildcard certificate via DNS-01.
- **Ingress CNAME target** (`INGRESS_CNAME`): what users point custom domains at.
- **Platform domain**: where the Orchard UI lives.
- **DB domain** (`PUBLIC_DB_DOMAIN`, optional): wildcard for publicly exposed
  databases.

A minimal production values file overrides at least:

```yaml
ingress:
  host: orchard.example.com
gateway:
  http:
    appDomain: apps.example.com
tenant:
  storageClass: '' # empty means cluster default
  ingressClass: nginx
  certClusterIssuer: letsencrypt-prod
signupMode: open
```

Every variable the server reads is listed in [Configuration](/reference/configuration/).

## Claiming the instance

A fresh install has no superadmin. On first boot the server mints a **single-use
setup token**, valid for 24 hours, and logs the URL that redeems it:

```bash
kubectl -n orchard logs deploy/server | grep -A2 'no superadmin'
```

Sign up with the account you want to own the instance, open that URL, and the
token is consumed. If it expires, restart the server to mint a new one.

:::caution
**Add a passkey straight after claiming.** Until you do, and with no SMTP
configured, a cleared cookie jar leaves nothing to sign in with. `sudo
orchardctl claim` will mint a recovery link in exactly that situation, but a
passkey is the thing that stops you needing one.
:::

## Trying it on a laptop

For a throwaway local cluster:

```bash
./scripts/quickstart.sh
```

It creates a k3d cluster, installs the prerequisites, and deploys the chart with
dev values.

## Before you put real work on it

A fresh install is not a production instance. Secrets, signup mode, TLS cookies,
control-plane backups and isolation all need deciding. Work through
[Going to production](/operate/production/).
