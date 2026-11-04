---
title: Install
description: Install Orchard on a Linux machine with the one-command installer, or on an existing Kubernetes cluster with the Helm chart.
sidebar:
  order: 2
---

To install Orchard, select the method that matches your environment.

| Environment | Method |
| --- | --- |
| A Linux machine with no cluster on it | [One-command installer](#install-on-a-linux-machine) |
| A Kubernetes cluster you already operate | [Helm chart](#install-on-an-existing-cluster) |
| A laptop, for a local trial | [Quickstart script](#try-orchard-on-a-laptop) |

After you install Orchard, [claim the instance](#claim-the-instance).

## Install on a Linux machine

The installer creates a single-node k3s cluster. It then installs Traefik, CloudNativePG, cert-manager, a zot registry, and Orchard. If the machine can already reach another Kubernetes cluster, the installer warns you and leaves that cluster alone.

### Prerequisites

- A physical machine or a virtual machine (VM) with an amd64 or arm64 CPU. The installer refuses other architectures.
- Root access.
- At least 4 GiB of RAM and 20 GB of free disk. Orchard recommends 8 GiB of RAM and 60 GB of disk.
- For `public` mode, ports 80 and 443 free. A domain is optional. To try Orchard without one, refer to [Try Orchard without a domain](#try-orchard-without-a-domain).
- For `tunnel` mode, a domain and a Cloudflare Tunnel token.

Do not run the installer inside a Docker container. k3s cannot nest its overlayfs snapshotter there.

### Choose an ingress mode

The ingress mode sets how traffic reaches the machine.

| Mode | Use for | TLS |
| --- | --- | --- |
| `public` | A routable IP address with DNS pointed at it | Let's Encrypt over HTTP-01 |
| `tunnel` | A machine behind NAT or CGNAT, through Cloudflare Tunnel | Cloudflare terminates TLS and the installer skips cert-manager |
| `lan` | A LAN or Tailscale network, reached by address | Self-signed certificates for apps. The dashboard uses plain HTTP. |

The mode also decides which host ports Orchard binds.

| Mode | Port 80 | Port 443 |
| --- | --- | --- |
| `public` | HTTP-01 challenges for the dashboard, the MCP endpoint, and every app hostname | All traffic |
| `lan` | The dashboard and the MCP endpoint, in plain HTTP | Deployed apps |
| `tunnel` | Not bound | Not bound |

:::caution
In `public` mode, port 80 must stay open after the install. Let's Encrypt uses it for every new app hostname and every certificate renewal. If another process owns port 80 or 443, use `tunnel` mode.
:::

### Add DNS records

For `public` mode with your own domain, add these `A` records before you run the installer. The example assumes the dashboard is at `orchard.example.com`.

| Record | Purpose |
| --- | --- |
| `orchard.example.com` | The dashboard |
| `*.apps.example.com` | Deployed apps and the [MCP endpoint](/mcp/) for agents |

The installer derives the other hostnames from your domain. Apps use `apps.example.com`, and the MCP endpoint uses `mcp.apps.example.com`, which the wildcard record covers. To change them, use `--app-domain` and `--mcp-domain`. A hostname that the wildcard record does not cover needs its own `A` record. To leave out the MCP endpoint, use `--mcp false`.

For `tunnel` mode, the installer prints the hostnames to route to your tunnel in the Cloudflare dashboard.

### Run the installer

1. Run the installer on the machine:

   ```bash
   sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)"
   ```

2. Answer the prompts. The installer asks for:

   - The ingress mode.
   - The domain for the dashboard. In `public` mode, you can press Enter to use an `sslip.io` name. In `lan` mode, the installer does not ask.
   - A Cloudflare Tunnel token (`tunnel` mode only).

3. Copy the claim link that the installer prints when it finishes.

The installer writes its settings to `/etc/orchard/values.yaml`. Next, [claim the instance](#claim-the-instance).

The installer sets the following values for you. To change one, use the flag in the table.

| Value | Default | Flag |
| --- | --- | --- |
| App domain | `apps.<parent of your domain>` | `--app-domain` |
| MCP hostname | `mcp.<app domain>` | `--mcp-domain` |
| Update policy | `manual` | `--updates automatic` |
| Let's Encrypt contact | None | `--email` |

Let's Encrypt and cert-manager do not need an email address. Let's Encrypt stopped sending expiry emails in June 2025, and cert-manager renews certificates without one.

:::note
Use `bash -c` as shown. If you pipe the script into `sudo bash` with no flags, the installer cannot read your answers, so it stops before it installs anything.
:::

To read the script before you run it:

```bash
curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh
less orchard-install.sh
sudo bash orchard-install.sh
```

### Try Orchard without a domain

In `public` mode, you can try Orchard before you point a domain at the machine. The installer uses [sslip.io](https://sslip.io), a public DNS service that answers with the IP address in the name.

1. Run the installer and select `public` mode.
2. When the installer asks for a domain, press Enter.

The dashboard is then at `https://orchard.<ip>.sslip.io`, with dashes in the IP address. You do not need to add DNS records. Let's Encrypt issues the certificates over HTTP-01, so ports 80 and 443 must be reachable from the internet.

:::caution
Use `sslip.io` for trials only. Let's Encrypt limits the certificates issued for each registered domain, and `sslip.io` is not on the Public Suffix List, so all its users share one limit. Its operators report a raised limit of 250,000 certificates, and they also say that requests can be rate limited. If the limit applies, the dashboard shows a browser warning until cert-manager succeeds on a later retry. The installer reports this when it finishes.
:::

### Move to your own domain

To move an instance from `sslip.io` to a domain you own:

1. Add the `A` records in [Add DNS records](#add-dns-records).
2. Run the installer again with your domain:

   ```bash
   sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)" -- --domain orchard.example.com
   ```

The installer updates the dashboard URL, the app domain, and the MCP hostname. Apps that you already deployed keep their `sslip.io` URLs. To give an app a new URL, add a domain to the app.

### Run the installer again

To pick up new host commands or change a setting, run the installer again. It reads `/etc/orchard/values.yaml` first, so it keeps your ingress mode, domains, MCP hostname, secrets, and update policy, and does not ask for them. A flag changes only the setting it names. It does not rotate secrets.

### Run the installer without prompts

Pass your answers as flags and add `--yes`:

```bash
curl -fsSL https://assets.orchard.my/install.sh | sudo bash -s -- \
  --yes --mode public --domain orchard.example.com
```

With `--yes`, every question takes its default. A `public` install with no `--domain` uses an `sslip.io` name. A `tunnel` install requires `--domain` and `--tunnel-token`.

Each flag also has an environment variable:

```bash
ORCHARD_ASSUME_YES=true \
ORCHARD_DOMAIN=orchard.example.com \
ORCHARD_INGRESS_MODE=public \
  sudo -E bash orchard-install.sh
```

To list every flag and variable, run the script with `--help`.

### Components the installer turns on

| Component | What runs | Flag to leave it out | Refer to |
| --- | --- | --- | --- |
| Metrics | VictoriaMetrics, vmagent, and exporters | `--metrics false` | [Metrics and alerts](/run/observability/) |
| Log search and request data | VictoriaLogs, Vector, and the Traefik JSON access log | `--logs false` | [Configure logs and request data](/operate/logs/) |
| Image scanning | The Orchard scanner (Trivy), which reads images from zot | `--image-scanning false` | [Set up image scanning](/operate/image-scanning/) |
| Database backups | A local S3 store (versitygw) and the backup proxy | `--object-storage false` | [Back up and restore a database](/data/backups/) |
| MCP | The endpoint agents connect to | `--mcp false` | [Connect an MCP client](/mcp/) |

:::caution
Backups in the local store sit on the same disk as your databases. They do not protect you if you lose the disk. For off-machine backups, refer to [Move to S3 or R2](/data/backups/#move-to-s3-or-r2).
:::

A host installed before these defaults existed receives them on its next `sudo orchardctl update`. The MCP endpoint is the exception. To turn it on, run `sudo orchardctl mcp enable --apply`. For more information, refer to [New defaults on an existing host](/operate/host-commands/#new-defaults-on-an-existing-host).

### Sizing

The installer sizes build concurrency and volumes from the machine.

| RAM | Concurrent builds |
| --- | --- |
| Under 8 GiB | 1 |
| 8 to 16 GiB | 2 |
| Over 16 GiB | 3 |

| Volume | Size |
| --- | --- |
| Build cache | One fifth of free disk, from 5 GB to 60 GB |
| Registry | One fifth of free disk, from 5 GB to 50 GB |
| Backups | One fifth of free disk, from 5 GB to 50 GB |
| Log store | One tenth of free disk, from 5 GB to 20 GB |

Under 8 GiB of RAM, metrics, logs, and the scanner use lower memory requests and limits. Logs are kept for 7 days instead of 14, and one scan runs at a time. To change any of these values, use `sudo orchardctl config set`.

### Change settings after the install

To change a chart value:

```bash
sudo orchardctl config set <key> <value> --apply
```

To change a server environment variable:

```bash
sudo orchardctl env set <NAME> <value> --apply
```

For the full list of commands, refer to [Host commands](/operate/host-commands/).

### What the installer does not configure

| Item | What to do |
| --- | --- |
| Sandboxed builds and tenant isolation | Install gVisor or Kata on the node, then set `tenantSandbox` and `builderSandbox` in `/etc/orchard/values.yaml`. Without them, image builds run with host-level privileges. |
| DNS for your own domain | Add the records yourself. To check them, go to **Instance admin** > **Networking**. For more information, refer to [Point DNS at this instance](/operate/finishing-setup/#point-dns-at-this-instance). |
| Public IP for raw ports and public databases, on a machine behind NAT | The installer saves the address when the machine has a routable IP in `public` mode. Otherwise, set it at **Instance admin** > **Configuration** > **Public exposure**. For more information, refer to [Set a default public IP](/operate/finishing-setup/#set-a-default-public-ip). |
| Off-machine backups | Refer to [Move to S3 or R2](/data/backups/#move-to-s3-or-r2). |
| Multiple nodes, wildcard certificates, and public TCP or UDP in `tunnel` mode | Use the [Helm chart](#install-on-an-existing-cluster). |

The following values turn on the sandboxes:

```yaml
tenantSandbox:
  enabled: true
  runtimeClassName: gvisor
builderSandbox:
  enabled: true
  runtimeClassName: kata
```

:::caution
By default, apps are network-isolated from each other and from the control plane. They share the host kernel unless you install gVisor or Kata. Do not run code you do not trust without them. For more information, refer to [Security and isolation](/operate/security/).
:::

### Use `lan` mode

A `lan` install serves the dashboard on the addresses that the machine has at install time. These include any Tailscale address, the hostname, the `.local` name, and an `orchard.<ip>.sslip.io` name. Generated app hostnames use `apps.<ip>.sslip.io`, because a wildcard cannot use an IP address. To use a wildcard you control, pass `--app-domain`.

To serve on other ports, pass `--http-port` and `--https-port`. Only `lan` mode accepts these flags.

```bash
sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)" -- \
  --mode lan --http-port 8080 --https-port 8443
```

The dashboard is then at `http://<host>:8080`, and apps are at `https://<app-host>:8443`.

To add a hostname after the install, and print a claim link that uses it:

```bash
sudo orchardctl hostname add mango --apply
sudo orchardctl claim --url mango
```

### Use Tailscale

Use `lan` mode for a machine that you reach over Tailscale. The installer detects the Tailscale address. You must add MagicDNS names yourself.

1. Find the machine's names and address:

   ```bash
   tailscale status
   tailscale ip -4
   ```

2. Add each name:

   ```bash
   sudo orchardctl hostname add mango --apply
   sudo orchardctl hostname add mango.tailnet-name.ts.net --apply
   ```

3. (Optional) To generate links with one of these names, change the primary hostname and the server URL together. Use the port the instance serves on, which is 80 by default.

   ```bash
   sudo orchardctl config set ingress.host mango
   sudo orchardctl env set FRONTEND_URL http://mango --apply
   sudo orchardctl claim
   ```

4. Confirm the hostnames that Traefik matches:

   ```bash
   sudo kubectl -n orchard get ingressroute orchard \
     -o jsonpath='{.spec.routes[*].match}'
   ```

### Hand the install to an agent

An agent with SSH access to the machine can run the installer. Point the agent at the Markdown version of this page:

```text
Install Orchard on <host> following https://docs.orchard.my/start/install.md
My domain is example.com.
Ask me before anything that is not reversible.
```

Decide these items before you start:

| Decision | Reason |
| --- | --- |
| The ingress mode | The agent can detect NAT. It cannot know if you intend to expose the machine. |
| The domain | Nothing on the machine shows which domains you own. |
| The DNS records | The records must exist before the run, and the agent may not have access to your DNS provider. |
| Whether to proceed | The installer installs k3s system-wide. Outside `tunnel` mode, it also takes ports 80 and 443. |

Open the claim link yourself. The link signs you in as the superadmin, so treat it as a password. If you lose it, `sudo orchardctl claim` creates another.

## Install on an existing cluster

The Helm chart installs Orchard's own components. It does not install cluster operators, so you provide them.

### Prerequisites

| Component | Needed for |
| --- | --- |
| CloudNativePG operator | The control-plane database and every database users create |
| Traefik | Control-plane ingress (`IngressRoute`) |
| Gateway API CRDs | The `Gateway` for database exposure, unless `gateway.enabled: false` |
| cert-manager | TLS, plus a DNS-01 `ClusterIssuer` for wildcard certificates |
| A default StorageClass | PostgreSQL volumes, build cache, Redis, metrics, and logs |
| An OCI registry | Where built images are pushed and pulled |
| An ingress controller | Every app URL, as an `Ingress` of class `tenant.ingressClass` |
| A layer 4 (L4) load balancer | Public database exposure and TCP or UDP passthrough only |
| gVisor or Kata RuntimeClasses | Optional sandboxing for tenant and builder pods |

You also need these domains:

| Domain | Setting | Purpose |
| --- | --- | --- |
| Dashboard domain | `ingress.host` | The dashboard |
| App domain | `APP_DOMAIN` | Wildcard DNS that points at your ingress controller's load balancer IP |
| Ingress CNAME target | `INGRESS_CNAME` | The target for users' custom domains |
| Database domain | `PUBLIC_DB_DOMAIN` | Optional wildcard for publicly exposed databases |

### Install with Helm

:::note
These steps were tested on k3s with the published chart, Helm 4.3.1, Traefik, cert-manager, and CloudNativePG. The test reached a working sign-in, an app with an HTTPS certificate, and a database with a bound volume. The test did not cover builds or MCP.
:::

1. Create the namespaces and the Secret. `jwt` signs sessions and must be at least 32 characters. `enc` encrypts stored secrets. Keep `enc` safe, because a new key makes existing encrypted values unreadable.

   ```bash
   kubectl create namespace orchard
   kubectl create namespace network
   kubectl -n orchard create secret generic orchard-secrets \
     --from-literal=jwt="$(openssl rand -base64 48 | tr -d '\n')" \
     --from-literal=enc="$(openssl rand -base64 32 | tr -d '\n')"
   ```

2. Write `my-values.yaml`. CI renders this file, from `infra/charts/orchard/examples/minimal-values.yaml`, on every chart change.

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
     ingressNamespaces: traefik,orchard
     certClusterIssuer: letsencrypt
   server:
     env:
       - { name: FRONTEND_URL, value: https://orchard.example.com }
       - name: JWT_SECRET
         valueFrom: { secretKeyRef: { name: orchard-secrets, key: jwt } }
       - name: SECRETS_ENCRYPTION_KEY
         valueFrom: { secretKeyRef: { name: orchard-secrets, key: enc } }
   ```

3. Replace the hostnames, then check these values against your cluster.

   | Value | What to set |
   | --- | --- |
   | `tenant.storageClass` | A class from `kubectl get storageclass`, or `''` for the cluster default |
   | `tenant.ingressClass` | A class from `kubectl get ingressclass` |
   | `tenant.ingressNamespaces` | The namespace your ingress controller's pods run in, followed by `orchard`, such as `ingress-nginx,orchard`. Tenant namespaces deny traffic by default. With the wrong value, apps are unreachable and HTTP-01 certificates are not issued. |
   | `tenant.certClusterIssuer` | A ClusterIssuer from `kubectl get clusterissuer`. Use the same issuer in `ingress.tls.issuerRef`. |
   | `gateway.http.enabled` | Leave `false`. App URLs use `Ingress`, and this listener needs a wildcard Secret that nothing creates. |
   | `certificates.enabled` | Leave `false` unless you have a DNS-01 issuer for wildcards. The default needs one named `letsencrypt-dns01-wildcard`. |
   | `mcp.enabled` | Leave `false` to start. The MCP endpoint needs [extra settings](#add-optional-features). |
   | `CNPG_OPERATOR_NAMESPACE` in `server.env` | The namespace where CloudNativePG runs. The default is `postgresql`. With the wrong value, the tenant network policy blocks the operator from database pods. |

4. Install the chart and wait for the API:

   ```bash
   helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
     --namespace orchard -f my-values.yaml
   kubectl -n orchard rollout status deploy/server --timeout=10m
   ```

5. Create a claim link. The server logs one link on first boot, on one replica only, so create one directly:

   ```bash
   kubectl -n orchard exec deploy/server -- node dist/scripts/mint-claim-link.js
   ```

Next, [claim the instance](#claim-the-instance).

If you keep `createNamespace: true`, the default, the chart creates `orchard` and any missing `network` namespace. In that case, pass `--create-namespace` and create the Secret after the install. The server waits for the Secret. The chart leaves an existing `network` namespace alone. A `network` namespace that the chart creates remains after `helm uninstall`.

### Add optional features

To turn on builds, add a registry that the cluster can reach. This configuration is untested on this path. In testing, a registry behind an ingress on the same node failed with a connection refused error during the push.

```yaml
builders:
  harbor:
    username: robot$orchard
    password: <registry password>
    hosts: [registry.example.com]
  registryEgress:
    - namespace: <namespace your registry runs in>
```

Also set `DOCKER_REGISTRY_PUSH`, `DOCKER_REGISTRY_PULL`, and `REGISTRY_PROJECT` in `server.env`.

To turn on MCP, set `mcp.enabled: true` and `mcp.ingress.host`. Set `JWT_SECRET` and `MCP_SERVICE_TOKEN` in `mcp.env`, and the same `MCP_SERVICE_TOKEN` in `server.env`. This configuration is untested on this path.

To turn on database backups, refer to [Backup storage for operators](/data/backups/#backup-storage-for-operators).

For every variable the server reads, refer to [Configuration](/reference/configuration/).

## Claim the instance

A new instance has no superadmin. The first person to redeem the claim link becomes the superadmin. The link works once. The token behind it is valid for 24 hours.

To create a new link on an installer host:

```bash
sudo orchardctl claim
```

To create a new link on a Helm install:

```bash
kubectl -n orchard exec deploy/server -- node dist/scripts/mint-claim-link.js
```

To claim the instance:

1. Open the claim link.
2. Enter the email address for the account. Orchard does not send a confirmation email.
3. Select **Set up your instance**.
4. Create a passkey, or set a password of at least 12 characters. Browsers do not offer passkeys over plain HTTP, so a `lan` install defaults to a password. You cannot skip this step.
5. Rename the organization, or keep the name Orchard created.
6. To create the GitHub App that repository deploys need, select **Create GitHub App**. To skip this step, select **Skip for now**.
7. If a wildcard certificate failed to issue, review its status. Otherwise, Orchard skips this step.
8. Choose whether to share anonymous usage reports. Reports are off unless you opt in.
9. Select **Go to Orchard**.

:::caution
Without SMTP, Orchard does not offer email codes on the sign-in page. Without SMTP or an identity provider, your passkey or password is the only way to sign in from a browser. If you lose access, run `sudo orchardctl login` to print a one-time sign-in link, or `sudo orchardctl password set` to set the superadmin password.
:::

## Try Orchard on a laptop

To create a local trial cluster, run the following script from a clone of the Orchard repository. It needs Docker, k3d, kubectl, and Helm.

```bash
./scripts/quickstart.sh
```

The script creates a k3d cluster, installs the prerequisites, and deploys the chart at `http://orchard.127.0.0.1.nip.io:8080`. It prints the steps to claim the instance.

The quickstart turns off image builds, so deploy from a container image. Its secrets are public, so do not expose this cluster.

## Verify what you install

GitHub Actions builds every Orchard release and signs a record of the commit and workflow. To verify a download, use the [GitHub CLI](https://cli.github.com).

To verify the install script:

```sh
curl -fsSLO https://assets.orchard.my/install.sh
curl -fsSLO https://assets.orchard.my/install.sh.sigstore.jsonl
gh attestation verify install.sh --bundle install.sh.sigstore.jsonl --owner hackclub
```

To verify a container image:

```sh
gh attestation verify oci://ghcr.io/hackclub/orchard/server:2.69.0 --owner hackclub --bundle-from-oci
```

CLI downloads include `attestation.sigstore.jsonl` on the release page. Orchard signs grafts in the Extension Marketplace with its own key and checks the signature on every install.

## Uninstall Orchard

:::danger
Uninstalling deletes every app, database, and volume on the instance. You cannot undo this action.
:::

To uninstall from an installer host:

```bash
sudo orchardctl uninstall
```

The command asks you to type a phrase that names the instance. It removes k3s, the values file that holds your secrets, the update timer, the host commands, Helm, and yq. For the full list, refer to [Host commands](/operate/host-commands/#uninstall).

To uninstall from an existing cluster:

```bash
helm uninstall orchard -n orchard
```

The release does not include the namespaces that Orchard created for apps and databases. Delete those namespaces yourself.

## Next steps

- [Deploy your first app](/start/first-deploy/)
- [Finish instance setup](/operate/finishing-setup/)
- [Go to production](/operate/production/)
