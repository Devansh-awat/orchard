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

## A bare Linux box

```bash
curl -fsSL https://raw.githubusercontent.com/leafdtk/leaf/main/install/install.sh | sudo bash
```

It installs k3s, Traefik, CloudNativePG, cert-manager, a `zot` registry for the
images it builds, and Orchard itself. Everything it generates lands in
`/etc/orchard/values.yaml`; edit that file and run `orchard-update` to apply
changes.

**amd64 only.** Image builds target `linux/amd64`, so the installer refuses to
run on other architectures rather than leaving you with apps that cannot start.

**Run it on a real machine or VM,** not inside a Docker container: k3s cannot
nest its overlayfs snapshotter there, and under CPU emulation seccomp is
unavailable, so the kubelet never creates a pod sandbox.

### What it asks

Two things it cannot work out on its own: your **domain**, and an **email for
Let's Encrypt**. Architecture, memory, free disk, free ports and whether you are
behind NAT are all detected.

It also asks how traffic reaches the box:

| Mode     | For                                        | TLS                                            |
| -------- | ------------------------------------------ | ---------------------------------------------- |
| `public` | A routable IP, DNS pointed at it           | Let's Encrypt over HTTP-01                     |
| `tunnel` | Behind NAT or CGNAT, via Cloudflare Tunnel | Cloudflare terminates it, cert-manager skipped |
| `lan`    | LAN only, `sslip.io` hostnames             | Self-signed                                    |

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
```

Others: `ORCHARD_VERSION`, `ORCHARD_CHART`, `ORCHARD_IMAGE_REGISTRY`,
`ORCHARD_IMAGE_REPOSITORY`, `ORCHARD_STATE_DIR`, `ORCHARD_NODE_PORT_RANGE`,
`ORCHARD_ZOT_NODE_PORT`, `ORCHARD_REGISTRY_HOST`, `ORCHARD_TUNNEL_TOKEN`,
`K3S_VERSION`, `GATEWAY_API_VERSION`.

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
helm install orchard oci://ghcr.io/leafdtk/leaf/charts/orchard \
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
  storageClass: "" # empty means cluster default
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
