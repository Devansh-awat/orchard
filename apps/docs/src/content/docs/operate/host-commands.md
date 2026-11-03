---
title: Host commands
description: orchardctl, the commands installed on an Orchard host.
sidebar:
  order: 4
---

`install.sh` puts a small set of commands on the host for operating the
instance: upgrading it, changing its configuration, and getting back in. They
are not the same thing as the [`orchard` CLI](/cli/), which deploys apps to any
instance over its API. These only work on the machine Orchard runs on.

```
orchardctl update            upgrade to the latest chart and images
orchardctl config ...        read and change chart values
orchardctl env ...           read and change control-plane environment variables
orchardctl registry ...      where builds are allowed to push
orchardctl policies ...      which namespaces may reach tenant apps
orchardctl mcp ...           the MCP endpoint agents connect to
orchardctl public-ip ...     default address for publicly exposed ports
orchardctl hostname ...      extra names the dashboard answers on
orchardctl claim             print a link to claim the instance and sign in
orchardctl login             print a one-time link that signs you in
orchardctl password ...      a password for the superadmin account
orchardctl stop              stop this instance until you start it again
orchardctl start             start it back up
orchardctl restart           both, back to back
orchardctl logs [service]    follow logs (server, frontend, mcp)
orchardctl status            show the control-plane pods
orchardctl sync              refresh these commands from the deployed image
orchardctl uninstall         remove Orchard, k3s and everything on them
```

Every subcommand also exists hyphenated, so `orchardctl config` and
`orchard-config` are the same program. `update`, `config`, `env`, `registry`,
`policies`, `mcp`, `public-ip`, `hostname`, `claim`, `login`, `password`,
`stop`, `start`, `restart`, `sync` and `uninstall` need root, because the values
file is `0600` and the rest runs through the cluster.

They read `/etc/orchard/env` for paths, falling back to defaults that work
unrendered, so a command copied straight out of the container still runs.

`orchardctl` is a single binary that ships inside the server image, one build
per architecture. The hyphenated names are symlinks to it; it decides what to do
from the name it was called by. `orchard-sync-commands` is the exception and
stays a shell script, because it is what fetches the binary in the first place:
`install.sh` reads it out of the image before anything is installed, and it is
the one thing that can recover a host with no `orchardctl` on it.

## update

```bash
sudo orchardctl update
```

In order, it:

1. runs `orchardctl harden`, so a host installed before the registry was locked
   down comes out of the upgrade fixed;
2. turns on, once, what newer releases do by default (see below);
3. repairs log and metrics volumes that never bound;
4. runs `helm upgrade --install` against the chart with your values file, and
   waits for each deployment to roll out;
5. makes sure Traefik writes the JSON access log the log store reads;
6. refreshes the host commands.

It also **restarts deployments whose image tag is a moving one**. The installer
pins tags to `latest`, so a new build reuses the same tag string, Helm sees an
identical pod template, writes no new ReplicaSet, and nothing re-pulls. Without
the restart `helm upgrade` reports success while leaving the old image running.
A tag that cannot be read is treated as moving: restarting a pinned deployment
costs one rollout, missing an update leaves a fixed bug undeployed.

Any extra arguments are passed through to `helm upgrade`.

### New defaults on an existing host

A fresh install gets everything on. A host installed earlier gets the same on
its next `update`. Each change is printed, and the values file is edited before
the upgrade, so `orchardctl config list` shows what happened.

| What                  | What it writes                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Metrics               | `metrics.enabled: true`, also when an older installer wrote `false`                               |
| Image scanning        | `trivy.enabled: true`                                                                             |
| Storage classes       | the log store, metrics and scanner volumes get the class Postgres already uses                    |
| Log disk cap          | `logs.maxDiskSpaceUsage`, from free disk                                                          |
| A box under 8G of RAM | smaller requests and limits for metrics, logs and the scanner, 7 days of logs, one scan at a time |
| Backups               | `objectStorage.local.enabled: true` and `r2Proxy.enabled: true`, sized from free disk             |

The log store needs no line of its own: `logs.enabled` is on in the chart, and
an older installer never wrote it.

Backups are the careful one. The local store is turned on **only when no object
storage is configured anywhere**: no `R2_ENDPOINT`, `R2_ACCOUNT_ID` or
`R2_BACKUP_BUCKET` in `server.env`, no `server.envFrom`, no
`r2Proxy.upstream.endpoint`, and nothing saved under **Instance admin →
Configuration → Object storage**. If it cannot read the database to check that
last one, it leaves the store off and prints the two commands that turn it on.
The local store is on the same machine as the databases, so it is not disaster
recovery; see [Backups and restore](/data/backups/#the-local-store-on-self-hosted-installs).

Apart from `metrics.enabled` and `r2Proxy.enabled`, which older installers wrote
as `false` themselves, only keys missing from the values file are filled in. A
value you set is never changed.

All of this happens once. The top-level `hostDefaults` key in the values file
records which round of defaults the file already has, so a later `update` does
not run it again. Turning something off afterwards sticks:

```bash
sudo orchardctl config set trivy.enabled false --apply
```

### Volumes and Traefik

The log store and VictoriaMetrics are StatefulSets, and a StatefulSet cannot
change its StorageClass in place. For each one, `update` checks the live volume
first. If it is bound, the values file is pinned to the class it already has,
so the upgrade does not fail. If it never bound (stuck `Pending`, usually
because the class it asked for does not exist here), the StatefulSet and its
empty claim are deleted and recreated on the class in the values file.

Traefik's access log is what the Requests view and attack signals read. If the
`traefik` release is missing any of the three settings it needs, `update`
upgrades that release with `--reuse-values` on the chart version already
deployed, setting only what is missing. If that fails, it prints the
`helm upgrade` command to run yourself. See
[Logs and request data](/operate/logs/#traefik).

## config

```bash
sudo orchardctl config get signupMode
sudo orchardctl config set signupMode open
sudo orchardctl config set server.replicas 3 --apply
sudo orchardctl config unset metrics.enabled
sudo orchardctl config list
sudo orchardctl config edit
```

Reads and writes the chart values at `/etc/orchard/values.yaml`. Paths are
dotted. Values are parsed as YAML, so `true` and `3` keep their types while a
bare word stays a string.

Changes are written but **not deployed**. Add `--apply` to run `update`
afterwards, or make every edit first and run it yourself once.

`config set` and `config unset` refuse to walk into or replace a list, because
the whole list would be replaced. `server.env` is a list, and it holds
`JWT_SECRET` and `SECRETS_ENCRYPTION_KEY`; lose the second and every secret
already stored becomes unreadable. Use [`orchardctl env`](#env) for environment
variables, and `config edit` for any other list.

Ones worth knowing:

| Path                                     | What it does                                          |
| ---------------------------------------- | ----------------------------------------------------- |
| `signupMode`                             | `open`, `invite_only` or `closed`                     |
| `tenant.certClusterIssuer`               | ClusterIssuer for user app certificates               |
| `ingress.tls.issuerRef.name`             | ClusterIssuer for the Orchard UI itself               |
| `server.replicas`                        | control-plane API pods                                |
| `cilium.enabled`                         | Cilium-backed policy and basic auth                   |
| `metrics.enabled`                        | the built-in metrics stack                            |
| `metrics.victoriametrics.retention`      | how long metrics are kept, for example `7d`           |
| `logs.enabled`                           | the [log store](/operate/logs/)                       |
| `logs.retention`                         | how long logs are kept, for example `14d`             |
| `logs.maxDiskSpaceUsage`                 | disk cap for logs, for example `8GiB`                 |
| `logs.victorialogs.storage.storageClass` | StorageClass for the log store                        |
| `trivy.enabled`                          | the Orchard [image scanner](/operate/image-scanning/) |
| `trivy.maxConcurrentScans`               | scans running at once                                 |
| `objectStorage.local.enabled`            | the S3 store on this box that backups go to           |
| `objectStorage.local.storage.size`       | its volume size, for example `40Gi`                   |
| `r2Proxy.enabled`                        | the backup proxy databases talk to                    |
| `r2Proxy.upstream.endpoint`              | real S3 or R2 for backups instead                     |
| `updates.url`                            | the "What's new" feed, or `off`                       |

## env

```bash
sudo orchardctl env list
sudo orchardctl env get FRONTEND_URL
sudo orchardctl env set SMTP_HOST smtp.example.com
sudo orchardctl env set R2_BACKUP_BUCKET my-backups --apply
sudo orchardctl env unset UPDATES_URL
sudo orchardctl env set PUBLIC_INGRESS_CNAME ingress.example.com --for frontend
```

Reads and changes the control plane's environment variables, which live in
`server.env` in the values file as a list of `{name, value}` entries. Each
command touches one entry and leaves the others alone, which is why it is safe
on a list that holds the instance's secrets.

- `list` prints the names that are set, not the values.
- `set` adds the variable, or changes it in place.
- `unset` removes it.
- `--for frontend` or `--for mcp` edits `frontend.env` or `mcp.env` instead of
  the server's.

Like `config`, changes are written but not deployed until `--apply` or the next
`update`. A variable set here also locks the matching field in the admin UI,
because the environment always wins.

## registry

```bash
sudo orchardctl registry
sudo orchardctl registry zot --apply
sudo orchardctl registry allow my-registry --label app=registry --port 5000
sudo orchardctl registry remove my-registry
```

Controls which registries builds are allowed to push to. Builds run firewalled
off from the rest of the cluster, so a registry that is not listed refuses the
push after an otherwise successful build. See
[Using your own registry](/operate/finishing-setup/#using-your-own-registry) for
what to set and why.

`allow` replaces any existing entry for the same namespace rather than adding a
second one, so it is safe to re-run.

## policies

```bash
sudo orchardctl policies
sudo orchardctl policies set traefik,orchard --apply
sudo orchardctl policies reapply
```

Controls which namespaces may reach tenant apps. Tenant namespaces are
default-deny, so the ingress controller has to be named or certificates never
issue. See
[Letting the ingress controller reach apps](/operate/finishing-setup/#letting-the-ingress-controller-reach-apps).

`set --apply` upgrades and then re-applies the policy to existing projects.
`reapply` restarts the server, which rewrites every managed namespace's policy
on boot.

## mcp

```bash
sudo orchardctl mcp
sudo orchardctl mcp enable --apply
sudo orchardctl mcp enable mcp.example.com --apply
sudo orchardctl mcp disable --apply
```

Turns the MCP endpoint on or off and decides which hostname it answers on. A
fresh install already has one at `mcp.<your domain>`; this is how an instance
that predates that, or one installed with `--mcp false`, gets it.

`enable` with no hostname reuses the one already in values, and failing that
derives a sibling of the UI's: `orchard.example.com` becomes `mcp.example.com`.
Point an A record for it at the box first, the same record as the UI.

It also does the wiring that is easy to miss: it copies `JWT_SECRET` across from
the server and mints a shared `MCP_SERVICE_TOKEN` if there is not one already.
The MCP authenticates to the API as a service and passes the consenting user
along, so without both the process starts happily and every tool call fails at
authentication.

Everything else follows what the UI's own route already does, including the
`issuerRef` that makes cert-manager issue a real certificate. Without it Traefik
answers with its self-signed default and MCP clients refuse to connect.

`disable` removes the deployment on the next upgrade. To stop it answering
without redeploying anything, use the toggle at
**Instance admin → Configuration** instead.

## public-ip

```bash
sudo orchardctl public-ip
sudo orchardctl public-ip set 203.0.113.10 --apply
sudo orchardctl public-ip unset --apply
```

Sets the address that raw TCP and UDP ports and public databases are published
on, for organizations that have not configured one of their own.

It is a fallback, not an override: an organization that sets its own still wins.
Unset, every organization is told to "set a public IP in organization settings"
for an address they have no way to know, which on a single-box install is only
ever this machine's.

Setting it here also locks the matching field at
**Instance admin → Configuration**, because it becomes an environment variable
on the server and the environment always wins.

## hostname

```bash
sudo orchardctl hostname
sudo orchardctl hostname add mango --apply
sudo orchardctl hostname remove mango --apply
```

Listing reads the values file, not the cluster. A name shows up there the
moment you add it and stays a 404 until a `helm upgrade` has run, so `add` and
`remove` say so unless you passed `--apply`.

Traefik routes the dashboard by `Host` header, so a name it was never told
about returns 404 even though the box is listening on the port. That is what
happens when you reach a LAN install by a name the installer did not know
about: a Tailscale name, an mDNS name, a DNS record added afterwards.

A `lan` install starts with every address the machine had at install time, its
hostname, its `.local` name and the `sslip.io` name, so this is for what
changed since: a Tailscale name, a DNS record added later, a machine renamed.

The primary hostname, the one generated links are built with, is not in this
list. Changing that one means changing two values together, because the name
Traefik matches and the name the server puts in links are separate settings and
a mismatch is the confusing failure: the dashboard answers, and every link it
prints points somewhere else.

```bash
sudo orchardctl config set ingress.host mango
sudo orchardctl env set FRONTEND_URL http://mango --apply
sudo orchardctl claim
```

`ingress.host` is a chart value, so it goes through `config set`.
`FRONTEND_URL` is an environment variable in the `server.env` list, so it goes
through [`env set`](#env). Include the port in the URL if the instance serves on
one other than 80 or 443.

What Traefik ended up matching on:

```bash
sudo kubectl -n orchard get ingressroute orchard \
  -o jsonpath='{.spec.routes[*].match}'
```

These names are **matched, not certified**. On an instance that terminates TLS,
a name with no certificate covering it is a browser warning rather than a
working address, which is why they suit LAN and Tailscale names best.

## claim

```bash
sudo orchardctl claim
sudo orchardctl claim --url mango
```

Prints a single-use link that claims the instance and signs you in as the
superadmin. Use it on a fresh install, or if you have locked yourself out. It
mints the link inside the server pod, so it works with no email configured.

For signing in day to day on an instance with no email, use
[login](#login) instead: `claim` deliberately refuses once there is any other
way in, and `login` does not.

The link is built from the address the instance generates links with, which is
not always the one you can reach it at. `--url` overrides it, and a bare name
picks up the scheme and port this instance serves on, so `--url mango` becomes
`http://mango:8081` on a lan install that moved off port 80. The address has to
be one Traefik answers on, so `orchardctl hostname add` it first if it is new.

It also works **after** the instance has been claimed, but only when there is
genuinely no other way in. Claiming a box, skipping the passkey step and then
clearing your cookies leaves nothing to sign in with if SMTP was never set up:
no code to email, no passkey to present. That is a permanent lockout from your
own machine, so this mints a recovery link instead.

While any way back in exists it refuses, and names the one to use:

```
This instance already has a superadmin, and a way to sign in as them.
Use your passkey. This only mints a link when there is no other way in.
```

A passkey on a superadmin, configured email, or a configured identity provider
each count. Adding any of them also sweeps away an outstanding recovery link on
the next restart, so the window closes on its own.

Recovering signs you in as the email you enter, so use the same address as
before. A different one creates a second superadmin. This grants nothing that
root on the box did not already have: the same access mints the link, and can
read the database it is stored in.

## login

```bash
sudo orchardctl login
sudo orchardctl login --email me@example.com
sudo orchardctl login --url mango
```

Prints a link that signs you in, valid for ten minutes and good once. It is
the same one-time code the email flow sends, minted on the box and printed
instead of mailed, which is what makes an instance with no SMTP configured
something you can sign into repeatedly rather than once.

Running it means having root here, which is already ownership of the instance,
so it hands out nothing that was not already yours. Minting a link also
invalidates any earlier one, so a link left in a scrollback stops working the
moment you print a new one.

`--url` builds the link with an address other than the one the instance
generates links with, for a box you reach by a different name. That name has to
be one Traefik answers on: see [hostname](#hostname).

Unlike `claim`, this does not care whether there is another way in. It is the
normal way to sign in on an instance that has no email, not a recovery path.

## password

```bash
sudo orchardctl password set
sudo orchardctl password clear
```

A password on the **superadmin account only**. Orchard signs people in with an
email code, a passkey or an identity provider; an instance with none of those
has nothing to sign in with once its claim link is spent, and passkeys need TLS
that a LAN install usually does not have.

It is deliberately not a general password system. It is set here rather than in
the dashboard because root on this box already owns the instance, there is no
self-service, and there is no reset email: running `set` again is the reset.
With more than one superadmin, name the one you mean with `--email`.

The password is typed at a prompt with the terminal echo off, never passed as
an argument, so it stays out of the shell history and the process list. It is
stored as a bcrypt hash. Twelve characters minimum, no other rules.

Setting one counts as a way in, so `orchardctl claim` stops minting recovery
links while it exists, the same as a passkey or configured SMTP would. The
first-run setup accepts it for the same reason: its opening step asks for a way
back into the instance, and on a plain-HTTP box a passkey cannot be that, so
the step offers a password there instead.

:::caution
On an instance served over plain HTTP the password crosses the network in the
clear on every sign-in. Over Tailscale or a VPN, WireGuard is doing the
encrypting and that is fine. On an untrusted network, prefer `orchardctl
login`, whose link cannot be reused once spent.
:::

## stop, start and restart

```bash
sudo orchardctl stop
sudo orchardctl start
sudo orchardctl restart
```

Everything Orchard runs is a pod, so there is nothing to stop above k3s and
nothing below it worth leaving up: these stop and start the k3s service, which
takes the dashboard, the API, your databases and every deployed app with it.

Nothing is deleted. Disks stay where they are, and apps come back on their own
when the node does, so nothing has to be redeployed. It is for taking a box off
the network for an afternoon or freeing the machine up for something else, not
for uninstalling.

`start` waits for the node to report Ready rather than returning the moment
systemd does, because the API server is not listening yet when it does. A
reboot has the same effect: k3s comes back on its own.

`restart` restarts **the cluster**, not the Orchard pods. To roll those without
touching k3s, use `orchardctl update`, which redeploys the chart and restarts
what needs it.

## logs and status

```bash
orchardctl status
orchardctl logs            # server
orchardctl logs frontend
orchardctl logs mcp
```

Neither needs root. `logs` follows, so exit with Ctrl-C.

These are the control plane, not your apps. Use the Orchard UI or the `orchard`
CLI for a deployment's logs.

## sync

```bash
sudo orchardctl sync
```

Copies `orchardctl` out of the running server image, which is where it ships
from, picking the build that matches the host's architecture, and re-links the
hyphenated aliases. That is how you pick up a command added or fixed in a later
release without re-running the installer.

The download is validated before it replaces the live binary: it must be at
least a kilobyte and start with the ELF magic number. It is written beside the
target and renamed, so a failure part-way through leaves the working copy in
place. A half-downloaded `orchardctl` would leave the host with no way to
upgrade itself, which is the worst thing this command could do.

`update` runs this for you at the end, so you rarely need it directly. Reach for
it when the docs mention a command your host does not have yet.

## uninstall

```bash
sudo orchardctl uninstall
```

Removes the instance for good. It lists what it is about to delete, then asks
you to type a phrase naming the instance, such as
`delete orchard.example.com`. Anything else stops it with nothing changed, and
no flag skips the question. A script that really means it can pipe the phrase
in.

In order, it:

1. disables `orchard-update.timer` and removes its units, so a nightly update
   cannot start part-way through;
2. runs `k3s-uninstall.sh`, which takes every app, database and volume with it;
3. removes what that script leaves behind:

| Path                                                                           | What it is                               |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| `/etc/orchard`                                                                 | The values file, with your secrets in it |
| `/usr/local/bin/orchardctl` and its `orchard-*` links                          | These commands                           |
| `/usr/local/bin/orchard-sync-commands`                                         | The shell bootstrap                      |
| `/usr/local/bin/helm`, `/usr/local/bin/yq`                                     | Tools the installer downloaded           |
| `/etc/rancher`, `/var/lib/rancher`                                             | What is left of k3s                      |
| `~/.kube`, and helm's directories in `~/.config`, `~/.cache`, `~/.local/share` | Root's kubectl and helm state            |

If `k3s-uninstall.sh` fails, it stops there and keeps `orchardctl` and the values
file, so you can run it again.

:::danger
It removes k3s and helm whether or not the installer put them there, and root's
`~/.kube` whatever else is in it. On a machine that ran k3s before Orchard, that
includes everything else on that cluster.
:::

Three things stay, because they are not on this machine or not only Orchard's:
database backups in off-host object storage, your DNS records, and the rules
the installer opened in ufw or firewalld.

## Upgrading from the shell version

Earlier releases shipped these as a set of shell scripts rather than one binary.
The switch takes two steps on an existing host, because the script doing the
copying is the one being replaced:

```bash
sudo orchardctl sync    # picks up the new bootstrap
sudo orchardctl sync    # installs the binary and links the aliases
```

The first run installs the new `orchard-sync-commands` and skips `orchardctl`
itself, because the old script validates what it downloads with `bash -n` and a
binary is not a shell script. That check is doing its job: it would rather skip
than install something it cannot verify. The second run is the new bootstrap,
which knows what a binary is.

`sudo orchardctl update` also runs the bootstrap at the end, so an upgrade
followed by one `sync` gets there too.
