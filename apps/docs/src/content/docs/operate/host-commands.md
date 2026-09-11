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
orchardctl registry ...      where builds are allowed to push
orchardctl policies ...      which namespaces may reach tenant apps
orchardctl claim             print a link to claim the instance and sign in
orchardctl logs [service]    follow logs (server, frontend, mcp)
orchardctl status            show the control-plane pods
orchardctl sync              refresh these commands from the deployed image
```

Every subcommand also exists hyphenated, so `orchardctl config` and
`orchard-config` are the same program. `update`, `config`, `registry`,
`policies`, `claim` and `sync` need root, because the values file is `0600` and the rest runs
through the cluster.

They read `/etc/orchard/env` for paths, falling back to defaults that work
unrendered, so a command copied straight out of the container still runs.

## update

```bash
sudo orchardctl update
```

Runs `helm upgrade --install` against the chart with your values file, then
waits for each deployment to roll out.

It also **restarts deployments whose image tag is a moving one**. The installer
pins tags to `latest`, so a new build reuses the same tag string, Helm sees an
identical pod template, writes no new ReplicaSet, and nothing re-pulls. Without
the restart `helm upgrade` reports success while leaving the old image running.
A tag that cannot be read is treated as moving: restarting a pinned deployment
costs one rollout, missing an update leaves a fixed bug undeployed.

Any extra arguments are passed through to `helm upgrade`.

Afterwards it refreshes the host commands, so a release that changes them lands
without anyone re-running the installer.

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

Ones worth knowing:

| Path | What it does |
| --- | --- |
| `signupMode` | `open`, `invite_only` or `closed` |
| `tenant.certClusterIssuer` | ClusterIssuer for user app certificates |
| `ingress.tls.issuerRef.name` | ClusterIssuer for the Orchard UI itself |
| `metrics.enabled` | the built-in metrics stack |
| `cilium.enabled` | Cilium-backed policy and basic auth |
| `server.replicas` | control-plane API pods |

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

## claim

```bash
sudo orchardctl claim
```

Prints a single-use link that claims the instance and signs you in as the
superadmin. Use it on a fresh install, or if you have locked yourself out. It
mints the link inside the server pod, so it works with no email configured.

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

Copies the host commands out of the running server image, which is where they
ship from. That is how you pick up a command added or fixed in a later release
without re-running the installer.

Each file is validated before it replaces the live one: it must be non-empty,
start with a shebang, and pass `bash -n`. Anything that fails is skipped with a
message, and files that are already identical are left alone. A half-downloaded
`orchard-update` would leave the host with no way to upgrade, which is the worst
thing this command could do, so it refuses to install one.

`update` runs this for you at the end, so you rarely need it directly. Reach for
it when the docs mention a command your host does not have yet.
