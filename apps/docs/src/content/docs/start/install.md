---
title: Install
description: Install Orchard on a Linux machine with the one-command installer, or on an existing Kubernetes cluster with the Helm chart.
sidebar:
  order: 2
---

To install Orchard, select the method that matches your environment.

| Environment                              | Method                                               |
| ---------------------------------------- | ---------------------------------------------------- |
| A Linux machine with no cluster on it    | [One-command installer](#install-on-a-linux-machine) |
| A Kubernetes cluster you already operate | [Helm chart](#install-on-an-existing-cluster)        |
| A laptop, for a local trial              | [Quickstart script](#try-orchard-on-a-laptop)        |

After you install Orchard, [claim the instance](#claim-the-instance).

## Install on a Linux machine

The installer creates a single-node k3s cluster. It then installs Traefik, CloudNativePG, cert-manager, a zot registry, and Orchard. If the machine can already reach another Kubernetes cluster, the installer warns you and leaves that cluster alone.

### Prerequisites

- A physical machine or a virtual machine (VM) with an amd64 or arm64 CPU. The installer refuses other architectures.
- An IPv4 address. IPv6-only servers are not supported yet. For more information, refer to [The installer stops on an IPv6-only server](/operate/troubleshooting/#the-installer-stops-on-an-ipv6-only-server).
- Root access.
- OpenSSL 3 or newer, which the published installer uses to check release signatures. Without it, the installer stops, unless you set `ORCHARD_ALLOW_UNSIGNED_COMMANDS=true` to install without the check.
- At least 4 GiB of RAM and 20 GB of free disk on `/var/lib`. The installer refuses less. For real use, plan for at least 8 GiB of RAM and 40 GB of disk. A small instance with two builds and a database uses about 2.5 GiB of RAM at idle, requests up to 4.5 GiB, and uses up to 19 GB of disk. The installer warns below 8 GiB of RAM and below 60 GB of free disk.
- For `public` mode, ports 80 and 443 free and reachable from the internet. A domain is optional. To try Orchard without one, refer to [Try Orchard without a domain](#try-orchard-without-a-domain).
- For `tunnel` mode, a domain and a Cloudflare Tunnel token.
- Outbound internet access. For the hosts the installer contacts, refer to [Outbound connections](/operate/outbound-connections/).

Do not run the installer inside a Docker container. k3s cannot nest its overlayfs snapshotter there.

### Choose an ingress mode

The ingress mode sets how traffic reaches the machine.

| Mode     | Use for                                                  | TLS                                                               |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `public` | A routable IP address with DNS pointed at it             | Let's Encrypt over HTTP-01                                        |
| `tunnel` | A machine behind NAT or CGNAT, through Cloudflare Tunnel | Cloudflare terminates TLS and the installer skips cert-manager    |
| `lan`    | A LAN or Tailscale network, reached by address           | Self-signed certificates for apps. The dashboard uses plain HTTP. |

The mode also decides which host ports Orchard binds.

| Mode     | Port 80                                                                        | Port 443      |
| -------- | ------------------------------------------------------------------------------ | ------------- |
| `public` | HTTP-01 challenges for the dashboard, the MCP endpoint, and every app hostname | All traffic   |
| `lan`    | The dashboard and the MCP endpoint, in plain HTTP                              | Deployed apps |
| `tunnel` | Not bound                                                                      | Not bound     |

:::caution
In `public` mode, port 80 must stay open after the install. Let's Encrypt uses it for every new app hostname and every certificate renewal. If another process owns port 80 or 443, use `tunnel` mode.
:::

### Run the installer

To install Orchard on the machine:

1. Run the installer:

   ```bash
   curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh && sudo bash orchard-install.sh
   ```

2. Answer the questions. Each question shows a default in brackets. To accept it, press Enter. For the full list, refer to [Installer questions](#installer-questions).

3. Review your answers. To install, press Enter. To change an answer, type its number. To cancel, type `c`. The installer checks the machine before it asks anything, and it installs nothing before you confirm this screen.

4. Create the DNS records that the installer prints, then select **Check again**. For more information, refer to [Add DNS records](#add-dns-records).

5. Copy the claim link that the installer prints when it finishes.

The installer writes its settings to `/etc/orchard/values.yaml` and to the Orchard database. Next, [claim the instance](#claim-the-instance).

:::note
Download the script to a file and run it, as shown. If you pipe the script into `sudo bash` with no flags, the installer cannot read your answers, so it stops before it installs anything. Do not pass the script to `bash -c`, because it is too long for a single command-line argument.
:::

To read the script before you run it:

```bash
curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh
less orchard-install.sh
sudo bash orchard-install.sh
```

### Installer questions

The installer asks these questions in order. A flag or an environment variable answers a question in advance, so the installer does not ask it. The answer still appears on the review screen.

| Question                                  | Default                                                                                                    | Flag                    | Environment variable                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------- |
| Ingress mode                              | Based on the machine's network                                                                             | `--mode`                | `ORCHARD_INGRESS_MODE`              |
| Cloudflare Tunnel token, in `tunnel` mode | None. Required in `tunnel` mode.                                                                           | `--tunnel-token`        | `ORCHARD_TUNNEL_TOKEN`              |
| Public IP                                 | The detected address. In `lan` mode, the local address. In `tunnel` mode, none.                            | `--public-ip`           | `ORCHARD_PUBLIC_IP`                 |
| Dashboard domain                          | An `sslip.io` name. In `lan` mode, the local address. Required in `tunnel` mode.                           | `--domain`              | `ORCHARD_DOMAIN`                    |
| Apps domain                               | `apps.<parent of your domain>`. In `tunnel` mode, the parent of your domain.                               | `--app-domain`          | `ORCHARD_APP_DOMAIN`                |
| Custom domains target                     | The dashboard domain. In `tunnel` mode, `<tunnel-id>.cfargotunnel.com`. In `lan` mode, an `sslip.io` name. | `--ingress-cname`       | `ORCHARD_INGRESS_CNAME`             |
| MCP endpoint, and its hostname            | On, at `mcp.<parent of your domain>`                                                                       | `--mcp`, `--mcp-domain` | `ORCHARD_MCP`, `ORCHARD_MCP_DOMAIN` |
| Let's Encrypt email, in `public` mode     | None                                                                                                       | `--email`               | `ORCHARD_ACME_EMAIL`                |
| Updates                                   | `manual`                                                                                                   | `--updates`             | `ORCHARD_UPDATE_POLICY`             |
| S3 storage                                | None                                                                                                       | `--s3-*`, `--no-s3`     | `ORCHARD_S3_*`                      |

The review screen also has one answer that the installer does not ask for: [resource limits](/operate/resource-limits/#choose-at-install). By default, you choose them during setup in the dashboard. To set them from the installer, change this answer on the review screen or use `--limits`. You can still change the value in the dashboard.

To leave the public IP, the custom domains target, or the email blank, type `none`. The result of each blank answer is:

- **Public IP:** Raw TCP and UDP ports and public databases are unavailable until you set an address.
- **Custom domains target:** Custom domains still work, but Orchard does not check their DNS before it requests a certificate.
- **Email:** Let's Encrypt has no address for notices about your account. Certificates still issue and renew.

The MCP hostname can be any name. A name directly under your apps domain, such as `mcp.apps.example.com`, needs no DNS record of its own, because the wildcard record covers it. Orchard reserves this name, so no app can take it.

### Add DNS records

For `public` mode with your own domain, the installer prints the records to create, computed from your answers. For example:

```txt
Type   Name                  Value
A      orchard.example.com   203.0.113.10
A      *.apps.example.com    203.0.113.10
A      mcp.example.com       203.0.113.10
```

To find the machine's public address, the installer asks `api.ipify.org`, `ipv4.icanhazip.com`, and `api6.ipify.org`. It then queries public DNS resolvers, `1.1.1.1` and `8.8.8.8` directly or `cloudflare-dns.com` and `dns.google` over HTTPS, and shows the status of each record. It does not wait in silence, and it does not stop the install. You can choose **Check again**, **Continue anyway**, **Skip DNS for now**, or **Change an answer**.

| Status        | Meaning                                         | What to do                                                                  |
| ------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `resolves`    | The record points at this machine.              | Nothing.                                                                    |
| `waiting`     | Public DNS has no answer yet.                   | Create the record, or wait for it to propagate.                             |
| `wrong value` | The record points somewhere else.               | Change the record. The old value can stay in caches for as long as its TTL. |
| `proxied`     | The record answers with a Cloudflare address.   | Refer to the following table.                                               |
| `not checked` | This machine could not reach a public resolver. | Check the record from another machine.                                      |

If you skip DNS or continue without it, Orchard installs. The dashboard, the claim link, and certificates do not work until the records are right. cert-manager retries on its own, first after about an hour. The summary at the end of the install lists what is still pending.

These cases need more than a new record:

| Case                                           | What the installer reports                                      | What to do                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare proxy (orange cloud)                | `proxied`, with the Cloudflare address it found                 | Set the record to **DNS only**. If you keep the proxy, turn off **Always Use HTTPS** so that Let's Encrypt can reach port 80, and set SSL mode to **Full (strict)**. Raw ports and databases do not pass through the proxy, and the free Cloudflare certificate does not cover names such as `*.apps.example.com`. |
| No wildcard records at your DNS provider       | `waiting` on the wildcard line                                  | Add one record for each app as you deploy it, or move the domain to a provider that supports wildcards.                                                                                                                                                                                                            |
| Subdomain delegated to other nameservers       | The zone, its nameservers, and the parent it was delegated from | Create the records at the provider for the delegated zone.                                                                                                                                                                                                                                                         |
| A website already on the top of the zone       | `wrong value`, and a warning about that site                    | Use a subdomain for the dashboard, such as `orchard.example.com`, to keep the site where it is.                                                                                                                                                                                                                    |
| Split-horizon DNS, or an entry in `/etc/hosts` | Both the answer on this machine and the public answer           | Create the public record. Let's Encrypt only uses public DNS.                                                                                                                                                                                                                                                      |
| A private address in public DNS                | `wrong value`, and the address                                  | Point the record at the public address, or use `lan` mode.                                                                                                                                                                                                                                                         |
| Ports 80 or 443 blocked by a provider firewall | A warning that names the firewall to open                       | Allow both ports. A test from the machine can only find this behind 1:1 NAT. On a machine that has the public address itself, the summary reports it when Let's Encrypt fails.                                                                                                                                     |
| Machine with both IPv4 and IPv6 addresses      | A note not to add `AAAA` records                                | Create `A` records only. Orchard listens on IPv4 only.                                                                                                                                                                                                                                                             |
| CAA records that exclude Let's Encrypt         | A warning with the record to add                                | Add `0 issue "letsencrypt.org"` to the zone.                                                                                                                                                                                                                                                                       |

For `tunnel` mode, the installer prints the hostnames to add to your tunnel:

```txt
Type   Name                  Value
CNAME  orchard.example.com   <tunnel-id>.cfargotunnel.com
CNAME  *.example.com         <tunnel-id>.cfargotunnel.com
```

1. In Cloudflare, go to **Zero Trust** > **Networks** > **Tunnels**, and select your tunnel.
2. Select **Public Hostname**.
3. Add each name, with the service `http://traefik.traefik.svc.cluster.local:80`. Cloudflare creates the CNAME for each name except the wildcard.
4. Go to **DNS** > **Records**, and add the wildcard as a proxied CNAME to the value that the installer printed.

Cloudflare's free certificate covers your domain and one level under it. For this reason, the apps domain defaults to the parent of your dashboard name in `tunnel` mode, so that apps are at `*.example.com`. A name deeper than one level, such as `*.apps.example.com` or `orchard.dev.example.com`, needs Advanced Certificate Manager. Without it, HTTPS fails at Cloudflare with a handshake error, even when the tunnel is healthy. The installer warns you about these names, and the summary reports a failed connection.

For `lan` mode, you do not need public DNS. For more information, refer to [Use `lan` mode](#use-lan-mode) and [Use Tailscale](#use-tailscale).

### Try Orchard without a domain

In `public` mode, you can try Orchard before you point a domain at the machine. The installer offers a name from [sslip.io](https://sslip.io), a public DNS service that answers with the IP address in the name.

1. Run the installer and select `public` mode.
2. At the dashboard domain question, press Enter.

The dashboard is then at `https://orchard.<ip>.sslip.io`, with dashes in the IP address. You do not need to add DNS records. Let's Encrypt issues the certificates over HTTP-01, so ports 80 and 443 must be reachable from the internet.

:::caution
Use `sslip.io` for trials only. Let's Encrypt limits the certificates issued for each registered domain, and `sslip.io` is not on the Public Suffix List, so all its users share one limit. Its operators report a raised limit of 250,000 certificates, and they also say that requests can be rate limited. If the limit applies, the dashboard shows a browser warning until cert-manager succeeds on a later retry. The installer reports this when it finishes.
:::

### Move to your own domain

To move an instance from `sslip.io` to a domain you own:

1. Run the installer again:

   ```bash
   curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh && sudo bash orchard-install.sh
   ```

2. On the review screen, type the number of **Dashboard**, and enter your domain. The apps domain, the MCP hostname, and the custom domains target follow it.
3. Press Enter to apply, and create the DNS records that the installer prints.

Apps that you already deployed keep their `sslip.io` URLs. To give an app a new URL, add a domain to the app.

### Run the installer again

To pick up new host commands or change a setting, run the installer again. It reads your current settings first and goes straight to the review screen, with each setting as the current answer. Anything that you leave alone does not change. With `--yes`, it keeps every setting that no flag names. It does not rotate secrets.

This includes everything in `/etc/orchard/values.yaml`, such as values that you set with [`orchardctl config set`](/operate/host-commands/#config) or [`orchardctl env set`](/operate/host-commands/#env), or edited by hand. A value changes only when you change an answer that it depends on. For example, a new dashboard domain updates `ingress.host` and `FRONTEND_URL`, and `signupMode` stays as it is.

When you change an answer, the installer states what the change affects:

| Change                | What it affects                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard domain      | Everyone signs in again. Passkeys belong to the old name and stop working, so use a password or `sudo orchardctl login`. The GitHub App and any SSO provider keep the old URL until you update them. |
| Apps domain           | Only new apps use it. Deployed apps keep their URLs, including after a redeploy, while DNS for the old name points at the machine. To move an app, add a domain to it.                               |
| MCP hostname          | Agents must reconnect at the new URL.                                                                                                                                                                |
| Custom domains target | Domains already added keep working while their CNAME still reaches the machine. Orchard checks new domains against the new target.                                                                   |
| Public IP             | Ports and databases that are already public stay on the old address until you turn public access off and on again.                                                                                   |

Before the installer changes the values file, it does the following:

- It prints each setting that changes. It hides the values of secrets.
- It saves a copy of the file as `/etc/orchard/values.yaml.<date>-<time>.bak`. Only root can read the copy. The copy contains your secrets, so delete it when you no longer need it.

The new file can lose comments and formatting. If no setting changes, the installer does not touch the file.

A newer release can add settings. The installer adds them to your file. It also adds back a setting that it writes and that you removed, and it prints that change. To turn off a feature, set it to `false` instead of removing it.

A newer release can also change a default. If you changed that setting, your value stays. The installer lists these settings so that you can compare them with the new default.

If the installer cannot read or update the values file, it stops and does not change the file. It saves a copy and states the problem. Fix the problem, then run the installer again. Do not delete the file. A new file means new secrets, and Orchard cannot read data encrypted with the old ones.

### Run the installer without prompts

Pass your answers as flags and add `--yes`:

```bash
curl -fsSL https://assets.orchard.my/install.sh | sudo bash -s -- \
  --yes --mode public --domain orchard.example.com
```

With `--yes`, the installer uses the flags first, then the current settings on a machine that already has Orchard, then the defaults. It checks DNS once, and it does not wait for DNS.

An answer with no default stops the run, and the message names the flag. A `tunnel` install needs `--domain` and `--tunnel-token`. A `public` install on a machine with no public address needs `--domain` or `--public-ip`.

Each flag also has an environment variable:

```bash
ORCHARD_ASSUME_YES=true \
ORCHARD_DOMAIN=orchard.example.com \
ORCHARD_INGRESS_MODE=public \
  sudo -E bash orchard-install.sh
```

To list every flag and variable, run the script with `--help`.

### Components the installer turns on

| Component                    | What runs                                                  | Flag to leave it out     | Refer to                                          |
| ---------------------------- | ---------------------------------------------------------- | ------------------------ | ------------------------------------------------- |
| Metrics                      | VictoriaMetrics, vmagent, and exporters                    | `--metrics false`        | [Metrics and alerts](/run/observability/)         |
| Log search and request data  | VictoriaLogs, Vector, and the Traefik JSON access log      | `--logs false`           | [Configure logs and request data](/operate/logs/) |
| Image scanning               | The Orchard scanner (Trivy), which reads images from zot   | `--image-scanning false` | [Set up image scanning](/operate/image-scanning/) |
| Database backups and uploads | An S3 store on the server (versitygw) and the backup proxy | `--object-storage false` | [Add S3 storage](/operate/storage/)               |
| MCP                          | The endpoint agents connect to                             | `--mcp false`            | [Connect an MCP client](/mcp/)                    |

:::caution
Backups on the server sit on the same disk as your databases. If the server is lost, the backups are lost. To keep backups off the server, refer to [Add S3 storage](/operate/storage/).
:::

A host installed before these defaults existed receives them on its next `sudo orchardctl update`. The MCP endpoint is the exception. To turn it on, run `sudo orchardctl mcp enable --apply`. For more information, refer to [New defaults on an existing host](/operate/host-commands/#new-defaults-on-an-existing-host).

On a machine where `kernel.apparmor_restrict_unprivileged_userns` is `1`, such as Ubuntu 24.04, the installer sets it to `0` in `/etc/sysctl.d/90-orchard-builds.conf`, because rootless builds need user namespaces. It skips this when `builderSandbox.enabled` or `builders.allowPrivilegedOnHost` is `true`.

### Sizing

The installer sizes build concurrency and volumes from the machine.

| RAM         | Concurrent builds |
| ----------- | ----------------- |
| Under 8 GiB | 1                 |
| 8 to 16 GiB | 2                 |
| Over 16 GiB | 3                 |

| Volume      | Size                                       |
| ----------- | ------------------------------------------ |
| Build cache | One fifth of free disk, from 5 GB to 60 GB |
| Registry    | One fifth of free disk, from 5 GB to 50 GB |
| Backups     | One fifth of free disk, from 5 GB to 50 GB |
| Log store   | One tenth of free disk, from 5 GB to 20 GB |

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

To change an answer that you gave the installer:

| Setting               | Where to change it                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Public IP             | **Instance admin** > **Configuration** > **Public exposure**                                     |
| Custom domains target | **Instance admin** > **Configuration** > **Custom domains**                                      |
| MCP on or off         | **Instance admin** > **Configuration** > **Model Context Protocol**                              |
| Dashboard domain      | `sudo orchardctl hostname set <host> --apply`                                                    |
| Apps domain           | `sudo orchardctl apps-domain set <domain> --apply`                                               |
| MCP hostname          | `sudo orchardctl mcp enable <host> --apply`                                                      |
| Let's Encrypt email   | `sudo orchardctl letsencrypt-email set <address>`                                                |
| Updates               | [Run the installer again](#run-the-installer-again).                                             |
| S3 storage            | **Instance admin** > **Configuration** > **Object storage**, or `sudo orchardctl backups s3 set` |
| Email (SMTP)          | **Instance admin** > **Configuration** > **Email**                                               |

**Instance admin** cannot change a setting that has a command, because it is a chart value or a host setting. For what each one affects, refer to [Change settings that Instance admin cannot edit](/operate/configuration/#change-settings-that-instance-admin-cannot-edit). For the full list of commands, refer to [Host commands](/operate/host-commands/).

### What the installer does not configure

| Item                                                   | What to do                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandboxed builds and tenant isolation                  | Install gVisor or Kata on the node, then set `tenantSandbox` and `builderSandbox` in `/etc/orchard/values.yaml`. Without them, image builds run rootless, and builds and apps share the host kernel.                                                      |
| DNS for your own domain                                | The installer prints the records and checks them, but you create them. To check them later, go to **Instance admin** > **Networking**. For more information, refer to [Point DNS at this instance](/operate/finishing-setup/#point-dns-at-this-instance). |
| Off-server backups                                     | The installer asks for S3 storage, and you can add it later. Refer to [Add S3 storage](/operate/storage/).                                                                                                                                                |
| Multiple nodes, and public TCP or UDP in `tunnel` mode | Use the [Helm chart](#install-on-an-existing-cluster).                                                                                                                                                                                                    |
| One certificate for every app URL                      | Add a DNS-01 issuer. Refer to [Set up wildcard certificates](/operate/wildcard-certificates/).                                                                                                                                                            |

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
curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh && sudo bash orchard-install.sh \
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

3. (Optional) To generate links with one of these names, change the primary hostname.

   ```bash
   sudo orchardctl hostname set mango --apply
   sudo orchardctl claim
   ```

4. Confirm the hostnames that Traefik matches:

   ```bash
   sudo kubectl -n orchard get ingressroute orchard \
     -o jsonpath='{.spec.routes[*].match}'
   ```

### Hand the install to an agent

An agent with SSH access to the machine can run the installer. Point the agent at the [Markdown version of this page](/for-agents/#get-a-page-as-markdown):

```text
Install Orchard on <host> following https://docs.orchard.my/start/install.md
My domain is example.com.
Ask me before anything that is not reversible.
```

Decide these items before you start:

| Decision           | Reason                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| The ingress mode   | The agent can detect NAT. It cannot know if you intend to expose the machine.                  |
| The domain         | Nothing on the machine shows which domains you own.                                            |
| The DNS records    | The records must exist before the run, and the agent may not have access to your DNS provider. |
| Whether to proceed | The installer installs k3s system-wide. Outside `tunnel` mode, it also takes ports 80 and 443. |

Open the claim link yourself. The link signs you in as the superadmin, so treat it as a password. If you lose it, `sudo orchardctl claim` creates another.

## Install on an existing cluster

To install Orchard on a Kubernetes cluster that you operate, install the prerequisites, write a values file, and install the Helm chart. The chart installs Orchard's own components. It does not install cluster operators, so you provide them.

:::note
These steps were run end to end on one node: k3s v1.36.5 with its bundled Traefik, Helm 4.3.1, Let's Encrypt over HTTP-01, and a registry behind an ingress on the same node. The run reached a working sign-in, an app built from a repository and served over HTTPS, and two healthy databases.

That run set `CNPG_OPERATOR_NAMESPACE` in `server.env`. The `tenant.cnpgOperatorNamespace` value used below sets the same variable. Its rendered output is checked in CI, but it has not been run on a cluster.

These were not tested on this path: MCP, public database exposure, more than one node, and other ingress controllers.
:::

### Prerequisites

| Component                     | Needed for                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| CloudNativePG operator        | The control-plane database and every database users create                                      |
| Traefik                       | Control-plane ingress (`IngressRoute`)                                                          |
| Gateway API CRDs              | The `Gateway` for database exposure, unless `gateway.enabled: false`                            |
| cert-manager                  | TLS, plus a DNS-01 `ClusterIssuer` for [wildcard certificates](/operate/wildcard-certificates/) |
| A default StorageClass        | Postgres volumes, build cache, Redis, metrics, and logs                                         |
| An OCI registry               | Where built images are pushed and pulled                                                        |
| An ingress controller         | Every app URL, as an `Ingress` of class `tenant.ingressClass`                                   |
| A layer 4 (L4) load balancer  | [Public database exposure](/data/databases/#public-access) and TCP or UDP passthrough only      |
| gVisor or Kata RuntimeClasses | [Optional sandboxing](/operate/security/#kernel-isolation) for tenant and builder pods          |

You also need these domains:

| Domain               | Setting                    | Purpose                                                                |
| -------------------- | -------------------------- | ---------------------------------------------------------------------- |
| Dashboard domain     | `ingress.host`             | The dashboard                                                          |
| App domain           | `APP_DOMAIN`               | Wildcard DNS that points at your ingress controller's load balancer IP |
| Ingress CNAME target | `INGRESS_CNAME`            | The target for users' custom domains                                   |
| Database domain      | `PUBLIC_DB_DOMAIN`         | Optional wildcard for publicly exposed databases                       |
| Public port domain   | `PUBLIC_DEPLOYMENT_DOMAIN` | Optional wildcard for publicly exposed ports                           |

### Install the prerequisites

k3s includes Traefik, the Gateway API CRDs, and the `local-path` StorageClass, so these steps do not install them.

1. Get the Gateway API CRDs ready.

   On k3s, do not install them. k3s installs them with Traefik in the first minutes after it starts, and CRDs that you apply yourself stop that install with `Required CRDs are missing`. Wait for Traefik instead:

   ```bash
   until kubectl -n kube-system get deploy traefik >/dev/null 2>&1; do sleep 5; done
   kubectl -n kube-system rollout status deploy/traefik --timeout=5m
   ```

   On any other cluster, install them if they are missing:

   ```bash
   kubectl get crd gateways.gateway.networking.k8s.io || \
     kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml
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

3. Point DNS for your dashboard domain and app domain at the ingress controller. Let's Encrypt must be able to reach port 80 on these hostnames.

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

To add Traefik to a cluster that does not have it, run the same command that the installer uses. Then use `traefik,orchard` for `tenant.ingressNamespaces`.

```bash
helm repo add traefik https://traefik.github.io/charts
helm upgrade --install traefik traefik/traefik \
  --namespace traefik --create-namespace \
  --set providers.kubernetesGateway.enabled=true \
  --set gateway.enabled=false \
  --wait --timeout 10m
```

### Install with Helm

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

3. Replace the hostnames, then check these values against your cluster.

   | Value                          | What to set                                                                                                                                                                                                                                                                                                                                        |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `tenant.storageClass`          | A class from `kubectl get storageclass`, or `''` for the cluster default                                                                                                                                                                                                                                                                           |
   | `tenant.ingressClass`          | A class from `kubectl get ingressclass`                                                                                                                                                                                                                                                                                                            |
   | `tenant.ingressNamespaces`     | The namespace your ingress controller's pods run in, followed by `orchard`. The Traefik bundled with k3s runs in `kube-system`. To find the namespace, run `kubectl get pods -A -l app.kubernetes.io/name=traefik`. Tenant namespaces deny traffic by default. With the wrong value, apps are unreachable and HTTP-01 certificates are not issued. |
   | `tenant.cnpgOperatorNamespace` | The namespace where CloudNativePG runs, which is `cnpg-system` in the commands above. With the wrong value, the tenant network policy blocks the operator, and databases show `Instance Status Extraction Error`.                                                                                                                                  |
   | `tenant.certClusterIssuer`     | A ClusterIssuer from `kubectl get clusterissuer`. Use the same issuer in `ingress.tls.issuerRef`.                                                                                                                                                                                                                                                  |
   | `gateway.http.enabled`         | Leave `false`. App URLs use `Ingress`, and this listener needs a wildcard Secret that nothing creates.                                                                                                                                                                                                                                             |
   | `certificates.enabled`         | Leave `false` unless you have a DNS-01 issuer for wildcards. The default needs one named `letsencrypt-dns01-wildcard`.                                                                                                                                                                                                                             |
   | `mcp.enabled`                  | Leave `false` to start. The MCP endpoint needs [extra settings](#turn-on-mcp).                                                                                                                                                                                                                                                                     |

   :::caution
   App pods can also open connections to the namespaces in `tenant.ingressNamespaces`. If you list `kube-system`, this includes the pods in `kube-system`. To keep apps away from them, turn off the bundled Traefik, install Traefik in its own namespace, and list that namespace instead.
   :::

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

### Upgrade the chart

To change a value or move to a new version, upgrade the release:

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard -f my-values.yaml --server-side=false
```

On Helm 4, pass `--server-side=false`. Orchard's server updates the `buildkit-config` ConfigMap when it runs a build, so a server-side upgrade after the first build fails with `conflict ... buildkit-config ... conflicts with unknown`. Helm 3 does not have this flag, so leave it out. A failed upgrade can leave settings partly applied, so run the upgrade again with the flag.

### Turn on image builds

Without a registry, a build stops with an error that names `DOCKER_REGISTRY_PUSH` and `DOCKER_REGISTRY_PULL`. To turn on builds:

1. Add the registry to `my-values.yaml`. Builders can reach DNS and public IP addresses on ports 80 and 443, plus what `builders.registryEgress` lists.

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

   If your registry is behind an ingress in the same cluster, the second entry is required, with the namespace of your ingress controller. The push goes to the ingress controller rather than the registry pod. Without this entry, the build fails at the push with `dial tcp <address>:443: connection refused`. Otherwise, remove the entry.

2. Add these variables to `server.env`:

   ```yaml
   - { name: DOCKER_REGISTRY_PUSH, value: registry.example.com }
   - { name: DOCKER_REGISTRY_PULL, value: registry.example.com }
   - { name: REGISTRY_PROJECT, value: orchard }
   - { name: HARBOR_USERNAME, value: robot$orchard }
   - { name: HARBOR_PASSWORD, value: <registry password> }
   ```

   Use the same username and password as `builders.harbor`. The server uses them to delete old images and to scan images.

3. [Upgrade the chart](#upgrade-the-chart).

4. Give every node credentials for the registry. Orchard does not add a pull secret to app pods for this registry, so without this step, a build succeeds and the pod then fails with `ErrImagePull` and `no basic auth credentials`.

   On k3s, write this file to `/etc/rancher/k3s/registries.yaml` on each node, then run `sudo systemctl restart k3s`:

   ```yaml
   configs:
     registry.example.com:
       auth:
         username: robot$orchard
         password: <registry password>
   ```

   On another distribution, use the registry configuration of its container runtime.

:::note
The `REGISTRY_PULL_SECRET_NAME` variable does not change how app pods pull. It names the Secret that build jobs in the `orchard-builders` namespace use to push.
:::

To use a registry that runs inside the cluster, refer to [Use your own registry](/operate/finishing-setup/#use-your-own-registry).

### Turn on backups

Without object storage, a backup request fails with `No backup storage`. To keep backups in a store inside the cluster, add these values and [upgrade the chart](#upgrade-the-chart):

```yaml
objectStorage:
  local:
    enabled: true
    storage: { size: 20Gi, storageClass: local-path }
```

These are the values that the installer writes.

:::caution
These backups sit on the same disk as your databases, so they do not protect you if you lose the disk. To use external storage, refer to [Backup storage for operators](/data/backups/#backup-storage-for-operators).
:::

### Turn on MCP

Set `mcp.enabled: true` and `mcp.ingress.host`. Set `JWT_SECRET` and `MCP_SERVICE_TOKEN` in `mcp.env`, and the same `MCP_SERVICE_TOKEN` in `server.env`. This configuration was not tested on this path.

For every variable the server reads, refer to [Environment variables](/reference/configuration/).

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
6. Complete the remaining steps. Orchard leaves out a step when the installer or your configuration already answered it. Each step that you can skip states what happens if you skip it.

   | Step                                                         | Shown when                                          | If you skip it                                                                           |
   | ------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
   | [GitHub App](/operate/finishing-setup/#connect-a-github-app) | No GitHub App exists                                | Private repositories and rebuilds on push do not work. Public repositories still deploy. |
   | [S3 storage](/operate/storage/)                              | No storage is set                                   | Backups stay on this server and are lost with it.                                        |
   | Resource limits                                              | You did not set them in the installer               | You must choose. You can change them later.                                              |
   | Public IP and domains                                        | You installed with the Helm chart                   | Public ports and databases are unavailable, and Orchard does not check custom domains.   |
   | [MCP endpoint](/mcp/)                                        | You installed with the Helm chart                   | Orchard keeps the current state.                                                         |
   | [Email](/operate/finishing-setup/#set-up-email)              | SMTP is not set                                     | Orchard has no email sign-in codes, and invitations are links that you copy.             |
   | Certificate                                                  | The instance has a certificate of its own to report | This step only shows the status and what to do if it failed.                             |
   | [Usage reports](/operate/telemetry/)                         | You have not answered                               | You must choose. Reports are off unless you opt in.                                      |

7. Review the list of what is configured and what you skipped. To change an item, select **Change**.
8. Select **Go to Orchard**.

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
gh attestation verify oci://ghcr.io/hackclub/orchard/server:<version> --owner hackclub --bundle-from-oci
```

CLI downloads include `attestation.sigstore.jsonl` on the release page. Orchard signs [grafts](/grafts/overview/) in the Extension Marketplace with its own key and checks the signature on every install.

## Uninstall Orchard

:::danger
Uninstalling deletes every app, database, and volume on the instance. You cannot undo this action.
:::

To uninstall from an installer host:

```bash
sudo orchardctl uninstall
```

The command asks you to type a phrase that names the instance. It removes k3s, the values file that holds your secrets, the update timer, the host commands, Helm, and yq. For the full list, refer to [Host commands](/operate/host-commands/#uninstall).

Backups stored off this machine, your DNS records, and the rules that the installer opened in ufw or firewalld stay in place.

To uninstall from an existing cluster:

```bash
helm uninstall orchard -n orchard
```

The release does not include the namespaces that Orchard created for apps and databases. List them, check the list, and then delete them:

```bash
kubectl get namespaces -l orchard.my/managed=true
kubectl delete namespaces -l orchard.my/managed=true
```

A `network` namespace that the chart created also remains. The operators that you installed, such as CloudNativePG, cert-manager, and Traefik, stay in place. Remove them only if nothing else uses them.

## Next steps

- [Deploy your first app](/start/first-deploy/)
- [Finish instance setup](/operate/finishing-setup/)
- [Go to production](/operate/production/)

## Related resources

- [What is Orchard](/start/what-is-orchard/)
- [Upgrade Orchard](/operate/upgrades/)
- [Host commands](/operate/host-commands/)
- [Configuration](/operate/configuration/)
- [Troubleshooting Orchard](/operate/troubleshooting/)
