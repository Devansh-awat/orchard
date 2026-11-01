---
title: Configuration
description: Where instance settings live and how they are changed.
sidebar:
  order: 2
---

Orchard is configured in two places, and knowing which is which saves a lot of
confusion.

## Environment variables

The server reads its configuration from the environment. This covers the things
that must be known at boot: database URL, registry, app domain, cluster access,
object storage, SMTP.

The full list is generated from `.env.example` and lives in
[Configuration reference](/reference/configuration/).

On installer-based instances these come from the `server.env` list in
`/etc/orchard/values.yaml`. Change them one at a time with
[`orchardctl env`](/operate/host-commands/#env), which leaves the rest of the
list, including the instance's secrets, alone:

```bash
sudo orchardctl env set SMTP_HOST smtp.example.com --apply
```

On chart-based instances they come from your values file.

## Instance settings

Some settings are stored in the database and changed from the admin UI at
runtime, without a restart. These are the operational toggles: signup mode,
feature switches, defaults for new organizations.

Where a setting exists in both places, the environment variable acts as an
override and can lock the value so it cannot be changed from the UI. That is what
you want for anything an instance operator must control absolutely.

## Cluster-specific values

Storage class, ingress class, registry, wildcard certificate domains and runtime
classes are all values rather than literals, because they differ per cluster.
Never hardcode them; set them in your values file.

## Secrets

Secrets belong in Kubernetes secrets, referenced by the chart, not in a values
file committed to a repository. The installer generates the ones it needs and
writes them into cluster secrets.

## The "What's new" sheet

The dashboard shows each person the latest release notes once, in a sheet,
until they dismiss it. The server reads the notes from a folder holding
`latest.json` and one markdown file per release, and the dashboard gets them
through the API, never from the folder directly.

| Setting                | Default                                |
| ---------------------- | -------------------------------------- |
| `UPDATES_URL`          | `https://assets.orchard.my/updates/ui` |
| `updates.url` in chart | `""`, which keeps the server's default |

- Set it to `off` to hide the sheet entirely.
- Point it at your own folder to publish your own notes. `latest.json` needs a
  `version` like `2.70.0`, and optionally a `file` (default `<version>.md`),
  `url` and `publishedAt`.
- A note only shows when its version is at or below the version of the UI the
  instance runs. An instance that has not upgraded yet never sees notes for a
  release it does not have.
- A value in `server.env` wins over `updates.url`.

```bash
sudo orchardctl config set updates.url off --apply
```
