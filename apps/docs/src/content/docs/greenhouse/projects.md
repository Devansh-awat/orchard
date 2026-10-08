---
title: Attach an Orchard project
description: Bring a project environment's variables and its database URL into a machine.
sidebar:
  order: 9
---

Code on a machine often needs the same configuration the deployed app has: API
keys for third-party services, feature flags, a database to point at. Attaching
an Orchard project writes one of its environments into the machine as an env
file that every shell loads.

## Attach

From the machine settings, or the CLI:

```bash
orchard sandbox link add leafy storefront --env staging
orchard sandbox link list leafy
```

Leave out `--env` to use the project's default environment. One environment per
project can be attached at a time; attaching again switches it.

Attaching is **host only**, and the host needs edit access to the project, the
same permission it takes to read its variables in the dashboard. The project must
belong to the machine's organization. Every attach and detach is recorded in the
audit log.

## What lands in the machine

Each attached project becomes a file:

```
~/.config/orchard/env/<project-slug>.env
```

It is owned by `dev`, readable only by `dev`, and rewritten whenever the
environment changes, so edits to it are lost. Login shells, terminals, the run
script and the setup script all load every file in that directory, so the
variables are simply there:

```bash
echo $STRIPE_PUBLISHABLE_KEY
psql "$DATABASE_URL"
```

The file contains:

- **The environment's shared variables**, as `KEY='value'` lines.
- **`DATABASE_URL`**, for the environment's first managed database, when that
  database has public access turned on. It connects over TLS to the public
  address. If public access is off, the file says so in a comment instead,
  because a machine cannot reach the cluster's internal network.

What it leaves out, with a comment explaining each:

- **Secret variables.** Orchard keeps secret values write only everywhere, and a
  machine is no exception. Set those yourself if you need them.
- **Variables that would break the shell**, such as `PATH`, `HOME` or `LD_PRELOAD`.

Changing a variable on the environment in the dashboard updates the file on every
machine it is attached to, typically within a few seconds while the machine is
running, and on its next start otherwise. Already open shells keep the values they
loaded; open a new terminal to pick up changes.

## Detach

```bash
orchard sandbox link remove leafy storefront
```

The env file is removed on the next sync. If the person who attached the project
loses edit access to it, its variables stop being written to the machine.

## Who can see the values

Everyone who can open a terminal or read files on the machine can read the env
file: the host and guests. Attach only what you are comfortable sharing with the
people you share the machine with.
