---
title: Host commands
description: Review orchardctl, the commands that the Orchard installer adds to a host to upgrade, configure, and sign in to an instance.
sidebar:
  order: 4
---

`orchardctl` operates an Orchard instance from the machine that runs it. The installer adds it to the host. The [`orchard` CLI](/cli/) is a different tool, which deploys apps to any instance over its API.

| Command                        | Purpose                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `orchardctl update`            | Upgrade to the latest chart and images.                                   |
| `orchardctl harden`            | Close the registry to outside traffic and open the firewall for k3s.      |
| `orchardctl config`            | Read and change chart values.                                             |
| `orchardctl env`               | Read and change control-plane environment variables.                      |
| `orchardctl registry`          | Set where builds can push.                                                |
| `orchardctl policies`          | Set which namespaces can reach tenant apps.                               |
| `orchardctl mcp`               | Manage the MCP endpoint.                                                  |
| `orchardctl graft`             | Install and manage [grafts](/grafts/install/).                            |
| `orchardctl public-ip`         | Set the default address for public ports.                                 |
| `orchardctl hostname`          | Change the dashboard domain, and add names that the dashboard answers on. |
| `orchardctl apps-domain`       | Change the domain that app addresses end in.                              |
| `orchardctl letsencrypt-email` | Change where Let's Encrypt sends notices.                                 |
| `orchardctl claim`             | Print a link that claims the instance.                                    |
| `orchardctl login`             | Print a one-time sign-in link.                                            |
| `orchardctl password`          | Set a password on the superadmin account.                                 |
| `orchardctl backups s3`        | Show or change the S3 storage for backups and uploads.                    |
| `orchardctl stop`              | Stop the instance.                                                        |
| `orchardctl start`             | Start the instance.                                                       |
| `orchardctl restart`           | Stop and start the instance.                                              |
| `orchardctl logs [service]`    | Follow logs for `server`, `frontend`, or `mcp`.                           |
| `orchardctl status`            | Show the control-plane pods.                                              |
| `orchardctl sync`              | Refresh these commands from the deployed image.                           |
| `orchardctl uninstall`         | Remove Orchard, k3s, and everything on them.                              |
| `orchardctl licenses`          | Print third-party notices.                                                |

Most commands also exist with a hyphen, such as `orchard-config` and `orchard-update`. All commands except `logs`, `status`, and `licenses` need root.

Every command has help. Add `--help` to a command to read it.

The commands read paths from `/etc/orchard/env`. `orchardctl` is one binary that ships in the server image, with a build for each architecture. The hyphenated names are links to it.

## update

```bash
sudo orchardctl update
```

Runs the following steps in order:

1. Runs `orchardctl harden`.
2. Turns on, once, what newer releases run by default.
3. Repairs log and metrics volumes that never bound.
4. Runs `helm upgrade --install` with your values file, and waits for each deployment to roll out.
5. Checks that Traefik writes the JSON access log.
6. Refreshes the host commands.

The command restarts a deployment if its image tag is empty or `latest`. Otherwise, Helm sees an identical pod template and the old image keeps running.

Any extra arguments go to `helm upgrade`.

### New defaults on an existing host

On its next `update`, a host installed earlier gets the same defaults as a new install. Orchard prints each change and edits the values file before the upgrade. To review the result, run `orchardctl config list`.

| Item              | Change                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics           | Sets `metrics.enabled: true`, including when an older installer wrote `false`.                                                           |
| Image scanning    | Sets `trivy.enabled: true`.                                                                                                              |
| Storage classes   | Gives the log store, metrics, and scanner volumes the class that Postgres uses.                                                          |
| Log disk limit    | Sets `logs.maxDiskSpaceUsage` from free disk.                                                                                            |
| Small machines    | Under 8 GB of memory, reduces requests and limits for metrics, logs, and the scanner, keeps 7 days of logs, and runs one scan at a time. |
| Backups           | Sets `objectStorage.local.enabled: true` and `r2Proxy.enabled: true`, sized from free disk.                                              |
| Database operator | Sets `CNPG_OPERATOR_NAMESPACE` to `cnpg-system`, if it is not set.                                                                       |
| Install mode      | Sets `INSTALL_INGRESS_MODE` from your values, if it is not set. The dashboard uses it to show these commands instead of Helm values.     |

Orchard turns on the local backup store only when no object storage is configured. It checks for `R2_ENDPOINT`, `R2_ACCOUNT_ID`, or `R2_BACKUP_BUCKET` in `server.env`, `server.envFrom`, `r2Proxy.upstream.endpoint`, and values at **Instance admin** > **Configuration** > **Object storage**. If it cannot read the database, it leaves the store off and prints the commands that turn it on.

Except for `metrics.enabled` and `r2Proxy.enabled`, which older installers wrote as `false`, Orchard only fills in keys that are missing. It does not change a value you set.

These changes happen once. The top-level `hostDefaults` key records which defaults a values file has. If you turn something off afterward, it stays off:

```bash
sudo orchardctl config set trivy.enabled false --apply
```

### Volumes and Traefik

A StatefulSet cannot change its StorageClass in place. For the log store and VictoriaMetrics, `update` checks the live volume. If it is bound, the values file is pinned to its class. If it never bound, `update` deletes the StatefulSet and its empty claim and recreates them on the class in the values file.

If the `traefik` release is missing any access log setting, `update` upgrades that release with `--reuse-values` on the deployed chart version. If that fails, it prints the `helm upgrade` command to run. For more information, refer to [Logs and request data](/operate/logs/#traefik).

## harden

```bash
sudo orchardctl harden
```

Moves the image registry onto loopback, adds a password to it, and gives that password to the containerd mirror and the builders. It also opens an active `ufw` or `firewalld` for k3s, and makes the k3s kubeconfig readable only by root.

`update` runs this command first. Run it directly only on a host that you do not want to upgrade yet. You can run it more than once.

`ORCHARD_REGISTRY_PORT` sets the loopback port. The default is `5000`.

## config

```bash
sudo orchardctl config get signupMode
sudo orchardctl config set signupMode open
sudo orchardctl config set server.replicas 3 --apply
sudo orchardctl config unset metrics.enabled
sudo orchardctl config list
sudo orchardctl config edit
```

Reads and writes the chart values at `/etc/orchard/values.yaml`. Paths are dotted. Values are parsed as YAML, so `true` and `3` keep their types.

Changes are not deployed until you add `--apply` or run `update`. These values stay when you re-run the installer.

`config set` and `config unset` refuse to change a list. `server.env` is a list that holds `JWT_SECRET` and `SECRETS_ENCRYPTION_KEY`. Use [`orchardctl env`](#env) for environment variables, and `config edit` for other lists.

| Path                                     | Purpose                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `signupMode`                             | `open`, `invite_only`, or `closed`.                                                                                |
| `tenant.certClusterIssuer`               | The ClusterIssuer for app certificates.                                                                            |
| `ingress.tls.issuerRef.name`             | The ClusterIssuer for the Orchard dashboard.                                                                       |
| `server.replicas`                        | The number of API pods.                                                                                            |
| `cilium.enabled`                         | Cilium-backed policy and basic auth.                                                                               |
| `metrics.enabled`                        | The built-in metrics stack.                                                                                        |
| `metrics.victoriametrics.retention`      | How long metrics are kept, such as `7d`.                                                                           |
| `logs.enabled`                           | The [log store](/operate/logs/).                                                                                   |
| `logs.retention`                         | How long logs are kept, such as `14d`.                                                                             |
| `logs.maxDiskSpaceUsage`                 | The disk limit for logs, such as `8GiB`.                                                                           |
| `logs.victorialogs.storage.storageClass` | The StorageClass for the log store.                                                                                |
| `trivy.enabled`                          | The Orchard [image scanner](/operate/image-scanning/).                                                             |
| `trivy.maxConcurrentScans`               | Scans running at once.                                                                                             |
| `objectStorage.local.enabled`            | The S3-compatible store on this machine for backups and uploads.                                                   |
| `objectStorage.local.storage.size`       | The volume size of that store, such as `40Gi`.                                                                     |
| `r2Proxy.enabled`                        | The backup proxy that databases use.                                                                               |
| `r2Proxy.upstream.endpoint`              | An S3 endpoint for backups, set in the values file. To set it in Orchard instead, use [`backups s3`](#backups-s3). |
| `updates.url`                            | The What's new feed, or `off`.                                                                                     |

## env

```bash
sudo orchardctl env list
sudo orchardctl env get FRONTEND_URL
sudo orchardctl env set SMTP_HOST smtp.example.com
sudo orchardctl env set R2_BACKUP_BUCKET my-backups --apply
sudo orchardctl env unset UPDATES_URL
sudo orchardctl env set PUBLIC_INGRESS_CNAME ingress.example.com --for frontend
```

Reads and changes the control plane's environment variables. These are `server.env` entries in the values file. Each command changes one entry and leaves the others.

| Subcommand or flag | Result                                                       |
| ------------------ | ------------------------------------------------------------ |
| `list`             | Prints the names that are set, not the values.               |
| `get`              | Prints one value.                                            |
| `set`              | Adds the variable, or changes it in place.                   |
| `unset`            | Removes the variable.                                        |
| `--for`            | With `frontend` or `mcp`, edits `frontend.env` or `mcp.env`. |

Changes are not deployed until you add `--apply` or run `update`. A variable set here locks the matching field in **Instance admin**. These settings stay when you re-run the installer.

## registry

```bash
sudo orchardctl registry
sudo orchardctl registry zot --apply
sudo orchardctl registry allow my-registry --label app=registry --port 5000
sudo orchardctl registry remove my-registry
```

Sets the registries that builds can reach. A build to an unlisted registry fails at the push. `allow` replaces any entry for the same namespace. For more information, refer to [Use your own registry](/operate/finishing-setup/#use-your-own-registry).

## policies

```bash
sudo orchardctl policies
sudo orchardctl policies set traefik,orchard --apply
sudo orchardctl policies reapply
```

Sets the namespaces that can reach tenant apps. `reapply` restarts the server, which rewrites the policy in every managed namespace. For more information, refer to [Let the ingress controller reach apps](/operate/finishing-setup/#let-the-ingress-controller-reach-apps).

## mcp

```bash
sudo orchardctl mcp
sudo orchardctl mcp enable --apply
sudo orchardctl mcp enable mcp.example.com --apply
sudo orchardctl mcp disable --apply
```

Turns the MCP endpoint on or off and sets its hostname. A new install has one at the hostname you gave the installer, unless you turned it off.

`enable` with a new hostname moves the endpoint, and agents must reconnect at the new URL. The URL keeps the port that the instance serves on. `enable` with no hostname uses the one in values. Otherwise, it uses `mcp.<app domain>`, which the wildcard record for your apps covers. For any other hostname, create an A record first.

`enable` also copies `JWT_SECRET` from the server and creates `MCP_SERVICE_TOKEN` if there is none. Without both, every tool call fails at authentication. It also sets the `issuerRef` so that cert-manager issues a certificate. Without a certificate, Traefik serves its self-signed default and MCP clients refuse to connect.

`disable` removes the deployment at the next upgrade. To stop the server from answering without a redeploy, use the toggle at **Instance admin** > **Configuration** > **Model Context Protocol**.

## graft

```bash
sudo orchardctl graft search
sudo orchardctl graft add greenhouse --apply
sudo orchardctl graft list
sudo orchardctl graft remove greenhouse --purge
```

Installs and manages grafts, the Orchard extensions. For more information, refer to [Install grafts](/grafts/install/), or run `orchardctl graft --help`.

## public-ip

```bash
sudo orchardctl public-ip
sudo orchardctl public-ip set 203.0.113.10 --apply
sudo orchardctl public-ip unset --apply
```

Pins the default address for raw TCP and UDP ports and public databases. An organization that sets its own address overrides it. Setting it here locks the field at **Instance admin** > **Configuration** > **Public exposure**. To keep the field editable, set the address there instead.

## hostname

```bash
sudo orchardctl hostname
sudo orchardctl hostname add mango --apply
sudo orchardctl hostname remove mango --apply
sudo orchardctl hostname set orchard.example.com --apply
```

Lists, adds, and removes names that the dashboard answers on. Traefik routes by `Host` header, so a name that is not listed returns a `404` status. Use this for a Tailscale name, an mDNS name, a DNS record added later, or a renamed machine. A `lan` install starts with the addresses, hostname, `.local` name, and `sslip.io` name that the machine had during installation.

The list reads the values file. A name shows in the list as soon as you add it, and returns a `404` status until `helm upgrade` runs.

These names are matched, not certified. On an instance that terminates TLS, a name with no certificate causes a browser warning.

The primary hostname is not in this list. To change it, use `set`. The command changes `ingress.host`, which is the name that Traefik matches, and `FRONTEND_URL`, which is the name in generated links. It keeps the scheme and port that the instance serves on, and it prints what the change affects. Outside `lan` mode, the name must be a domain, such as `orchard.example.com`. For more information, refer to [Dashboard domain](/operate/configuration/#dashboard-domain).

To see what Traefik matches, run the following command:

```bash
sudo kubectl -n orchard get ingressroute orchard \
  -o jsonpath='{.spec.routes[*].match}'
```

## apps-domain

```bash
sudo orchardctl apps-domain
sudo orchardctl apps-domain set apps.example.com --apply
```

Shows or changes the domain that app addresses end in. The command changes `gateway.http.appDomain` and `APP_DOMAIN` together, and removes a pinned `PUBLIC_APP_DOMAIN` from `frontend.env`. If `tenant.wildcardDomains` or `PLATFORM_WILDCARD_DOMAINS` is set, the command warns you, because these take precedence. For more information, refer to [Apps domain](/operate/configuration/#apps-domain).

## letsencrypt-email

```bash
sudo orchardctl letsencrypt-email
sudo orchardctl letsencrypt-email set you@example.com
sudo orchardctl letsencrypt-email unset
```

Shows, changes, or removes the address where Let's Encrypt sends notices. The address is on the `letsencrypt` ClusterIssuer, so a change takes effect right away and does not need `--apply`. Certificates are not affected. In `lan` and `tunnel` modes, the command stops, because these modes do not use Let's Encrypt.

## claim

```bash
sudo orchardctl claim
sudo orchardctl claim --url mango
```

Prints a single-use link that claims the instance and signs you in as the superadmin. It works without email.

`--url` overrides the address in the link. A bare name uses the scheme and port that the instance serves on. For example, `--url mango` becomes `http://mango:8081` on a `lan` install that moved off port 80. Add the name with `orchardctl hostname add` first.

After the instance is claimed, this command only prints a link if there is no other way in. If a way in exists, the command refuses and names it:

```txt
This instance already has a superadmin, and a way to sign in as them.
Use your passkey. This only mints a link when there is no other way in.
```

A passkey on a superadmin, a superadmin password, configured email, or a configured identity provider each count as a way in.

Enter the same email address as before when you use a recovery link. A different address creates a second superadmin.

To sign in day to day, use [`login`](#login).

## login

```bash
sudo orchardctl login
sudo orchardctl login --email me@example.com
sudo orchardctl login --url mango
```

Prints a link that signs you in as the superadmin, or as the account in `--email`. The link is valid for 10 minutes and works once. A new link replaces any earlier one. It works with or without email configured.

`--url` builds the link with another address. The address must be one that Traefik answers on. For more information, refer to [hostname](#hostname).

## password

```bash
sudo orchardctl password set
sudo orchardctl password clear
```

Sets or removes a password on a superadmin account. Other accounts cannot have a password. Running `set` again resets the password. With more than one superadmin, add `--email`.

The command prompts for the password and turns off terminal echo, so the password stays out of the shell history and the process list. Orchard stores a bcrypt hash. The minimum length is 12 characters.

:::caution
On an instance served over plain HTTP, the password crosses the network in clear text at each sign-in. On an untrusted network, use `orchardctl login`.
:::

## backups s3

To show or change the S3 storage for backups and uploads, use `orchardctl backups s3`.

```bash
sudo orchardctl backups s3 status
sudo orchardctl backups s3 test --endpoint https://s3.eu-west-1.amazonaws.com --bucket my-bucket --region eu-west-1 --path-style false --access-key <KEY_ID>
sudo orchardctl backups s3 set --endpoint https://s3.eu-west-1.amazonaws.com --bucket my-bucket --region eu-west-1 --path-style false --access-key <KEY_ID>
sudo orchardctl backups s3 clear
```

`set` tests the connection first and saves nothing if the test fails. To save without the test, add `--skip-test`. Both `test` and `set` ask for the secret key, or read it from `--secret-key-file` or `ORCHARD_S3_SECRET_KEY`. `--secret-key` also works, but it stays in your shell history.

`clear` removes the saved settings. Backups then go back to the store on the server, if the instance has one.

A change applies to new databases. For more information, refer to [Add S3 storage](/operate/storage/#what-happens-when-you-change-storage).

## stop, start, and restart

```bash
sudo orchardctl stop
sudo orchardctl start
sudo orchardctl restart
```

Stops and starts the k3s service. This affects the dashboard, the API, your databases, and every app. Disks stay in place and nothing is deleted. Apps come back when the node does.

`start` waits for the node to report `Ready`. A reboot has the same effect as `start`.

`restart` restarts the cluster, not only the Orchard pods. To restart Orchard pods without restarting k3s, use `update`.

## logs and status

```bash
orchardctl status
orchardctl logs            # server
orchardctl logs frontend
orchardctl logs mcp
```

These commands do not need root. `logs` keeps following until you press `CTRL + C`.

These commands show the control plane, not your apps. For an app's logs, use the dashboard or the `orchard` CLI.

## sync

```bash
sudo orchardctl sync
```

Copies `orchardctl` from the running server image, for the host's architecture, and re-creates the hyphenated links. Use it when documentation mentions a command that your host does not have yet. `update` runs this command at the end.

The command checks the download before it replaces the binary. The file must be at least one kilobyte and an ELF binary.

## uninstall

```bash
sudo orchardctl uninstall
```

Removes the instance permanently. The command lists what it deletes, then asks you to type a phrase that names the instance, such as `delete orchard.example.com`. Any other input stops the command with nothing changed. No flag skips the question. A script can pipe the phrase in.

The command runs the following steps:

1. Disables `orchard-update.timer` and removes its units.
2. Runs `k3s-uninstall.sh`, which deletes every app, database, and volume.
3. Removes the following paths:

| Path                                                                           | Contents                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------- |
| `/etc/orchard`                                                                 | The values file, which includes your secrets. |
| `/usr/local/bin/orchardctl` and its `orchard-*` links                          | These commands.                               |
| `/usr/local/bin/orchard-sync-commands`                                         | The shell script that installs them.          |
| `/usr/local/bin/helm`, `/usr/local/bin/yq`                                     | Tools that the installer downloaded.          |
| `/etc/rancher`, `/var/lib/rancher`                                             | What remains of k3s.                          |
| `/var/lib/vector-orchard`, `/etc/cni`                                          | Log checkpoints and CNI configuration.        |
| `~/.kube`, and helm's directories in `~/.config`, `~/.cache`, `~/.local/share` | Root's kubectl and helm state.                |

If `k3s-uninstall.sh` fails, the command stops and keeps `orchardctl` and the values file, so you can run it again.

:::caution
The command removes k3s and helm even if the installer did not put them there, and removes all of root's `~/.kube`. On a machine that ran k3s before Orchard, this includes everything else on that cluster.
:::

The command does not remove database backups stored off this machine, your DNS records, or the rules that the installer added to `ufw` or `firewalld`.

## Upgrade from the shell version

Earlier releases shipped these commands as shell scripts. On a host with the shell version, run `sync` twice:

```bash
sudo orchardctl sync    # installs the new bootstrap script
sudo orchardctl sync    # installs the binary and links the aliases
```

`sudo orchardctl update` also runs the bootstrap at the end, so an upgrade followed by one `sync` has the same result.

## Related resources

- [Configuration](/operate/configuration/)
- [Upgrade Orchard](/operate/upgrades/)
- [Use the CLI](/cli/)
