# One-command install

For a single Linux box with nothing on it yet:

```bash
curl -fsSL https://raw.githubusercontent.com/leafdtk/leaf/main/install/install.sh | sudo bash
```

This is the amateur-friendly path. It creates its own k3s cluster and installs
everything Orchard needs. If you already run Kubernetes, do **not** use this.
Install the Helm chart instead and keep your own platform layer
([docs/self-hosting.md](../docs/self-hosting.md)).

## What it installs

| Component | Why |
|---|---|
| k3s | The cluster. Traefik disabled (installed separately), servicelb kept |
| Traefik | Control-plane ingress and the app Gateway |
| CloudNativePG | Orchard's own database and every database you create |
| cert-manager | TLS, unless Cloudflare is terminating it for you |
| zot | Registry for images Orchard builds |
| Orchard | The Helm chart, with a generated values file |

Everything lands in `/etc/orchard/values.yaml`. Edit that file and run
`orchard-update` to apply changes.

## What it asks

Two things it cannot work out on its own: your **domain**, and an **email for
Let's Encrypt**. Everything else is detected: architecture, memory, free disk,
free ports, whether you are behind NAT.

amd64 only for now. Image builds target `linux/amd64`, so the installer refuses
to run on anything else rather than leave you with apps that cannot start.

Run it on a real machine or VM. Inside a Docker container k3s cannot nest its
overlayfs snapshotter, and under CPU emulation seccomp is unavailable, so the
kubelet never creates a pod sandbox.

It also asks how traffic should reach the box:

- **public**: you have a routable IP; point DNS at it and Let's Encrypt issues
  certificates over HTTP-01
- **tunnel**: Cloudflare Tunnel, for boxes behind NAT or CGNAT. Cloudflare
  terminates TLS, so cert-manager is skipped entirely
- **lan**: LAN only, `sslip.io` hostnames, self-signed certificates

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

| RAM | Concurrent builds |
|---|---|
| < 8Gi | 1 |
| 8–16Gi | 2 |
| > 16Gi | 3 |

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
tenantSandbox:                # gVisor for tenant app pods
  enabled: true
  runtimeClassName: gvisor
builderSandbox:               # Kata VMs for build jobs
  enabled: true
  runtimeClassName: kata
```

**Multi-node.** One box only. For multiple nodes, use the Helm chart.

**Wildcard certificates.** Apps get per-hostname certificates. Wildcards need a
DNS-01 issuer; see [SETUP-wildcards.md](../infra/charts/orchard/SETUP-wildcards.md).

**Public TCP/UDP in tunnel mode.** Cloudflare Tunnels carry HTTP only, so
publicly exposed databases and raw ports are unavailable there.

## Environment overrides

Every prompt has an environment variable, so the whole thing can run unattended:

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
