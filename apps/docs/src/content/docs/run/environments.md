---
title: Environments and variables
description: Per-app variables, shared project variables, and keeping production separate.
sidebar:
  order: 1
---

## App variables

Each app has its own variables on the **Variables** tab, editable as a form or as
raw `.env` text. Changing them restarts the app, because a process reads its
environment once at startup.

## Shared variables

A project can hold variables that every app in it receives. Put the things that
are genuinely shared there (an API base URL, a region, a feature flag) so you
change them once instead of per app.

An app-level variable of the same name wins over a shared one.

## Environments

A project has environments, `Production` by default. Variables can be scoped to
one, so staging and production differ without maintaining duplicate projects.

## Secrets

Secret values are **encrypted at rest** and are **write-only in the UI**: once
saved you can replace a value but not read it back. That is deliberate. A
dashboard that will happily print every production credential to anyone with a
session is a liability, and "I need to check what it is" is almost always
"I need to set it again".

Size limits apply, because environment variables are not a file store.

## Pulling them locally

The CLI can pull an app's variables into a local `.env` so development matches
what runs on the cluster:

```bash
orchard env pull
```

Check `orchard env --help` for the exact flags in your version, or the
[CLI reference](/reference/cli/).

## What not to put here

Anything large, anything binary, and anything that changes per request. Mount
[storage](/deploy/storage/) for files, and use a database for data.
