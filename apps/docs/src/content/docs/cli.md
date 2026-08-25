---
title: CLI
description: Install the orchard CLI, sign in, and drive the platform from a terminal.
---

The CLI speaks the same API as the dashboard. Output is human-readable in a
terminal and JSON when piped, so scripts get the same powers you do.

The complete command tree is generated from the binary itself:
**[CLI reference](/reference/cli/)**.

## Install

```bash
brew install --cask leafdtk/tap/orchard-cli
```

The cask is `orchard-cli` because Homebrew core already owns the name `orchard`
for an unrelated project. The installed binary is still `orchard`.

Or, without Homebrew:

```bash
curl -fsSL https://raw.githubusercontent.com/LeafdTK/orchard-releases/main/install.sh | sh
```

Or from source, if you have Go:

```bash
go install github.com/LeafdTK/leaf/cli@latest
```

## Sign in

```bash
orchard auth login
```

This opens a browser to authorise the CLI against your instance and stores the
token locally.

## Context

Most commands act on an organization and an environment. Set them once instead of
passing them every time:

```bash
orchard link
```

Any command takes `--org` and `--env` to override the saved context for a single
invocation.

## Everyday use

```bash
orchard deploy list                 # what is running
orchard deploy scale <app> 3        # change replicas
orchard logs <app>                  # stream logs
orchard env pull                    # write an app's variables into a local .env
orchard db list                     # databases
orchard job run <job>               # trigger a job
```

## Scripting

Everything supports `-o json`:

```bash
orchard deploy list -o json | jq -r '.[] | select(.status != "running") | .name'
```

`orchard commands -o json` dumps the entire command tree, including every flag,
which is how this documentation's reference page is generated and a reasonable
way for an agent to discover the surface.

## Exit codes

Commands exit non-zero on failure, so `set -e` scripts behave. Do not wrap a step
in `|| true` unless you genuinely do not care whether it worked.
