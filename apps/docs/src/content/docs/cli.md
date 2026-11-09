---
title: Use the CLI
description: Install the Orchard CLI, sign in to an instance, set a default project, and script commands with JSON output.
---

The `orchard` command-line interface (CLI) calls the same API as the dashboard. Use it to deploy apps, read logs, and manage databases from a terminal or a script.

For every command and flag, refer to the [CLI reference](/reference/cli/). To run commands on the machine that hosts Orchard, refer to [Host commands](/operate/host-commands/).

## Install the CLI

To install with Homebrew, run the following command:

```bash
brew install --cask leafdtk/tap/orchard-cli
```

The cask is named `orchard-cli`. The installed command is `orchard`.

To install without Homebrew, run the following install script:

```bash
curl -fsSL https://raw.githubusercontent.com/LeafdTK/orchard-releases/main/install.sh | sh
```

To confirm the installation, run the following command:

```bash
orchard version
```

## Sign in

To sign in to an instance, run the following command:

```bash
orchard auth login --api-url https://orchard.example.com
```

The command opens a browser. After you approve the request, the CLI stores a token in `~/.orchard/config.json`.

If you run `orchard auth login` without `--api-url`, the CLI asks which instance to use. Enter the URL of your instance. The default answer is Hack Club's own instance.

## Work with several instances

Each instance you sign in to becomes a context: its URL, your token for it, and the default organization, project and environment you set with `orchard use`. Signing in to another instance adds a context and switches to it.

```bash
orchard auth login --api-url https://orchard.acme.dev --name acme
orchard context list
orchard context use          # pick from a list
orchard context use acme
```

To run a single command against another instance, pass `--context <name>` or set `ORCHARD_CONTEXT`. Rename a context with `orchard context rename` and forget one, with its token, with `orchard context remove`.

To sign in on a machine with no browser, add `--no-browser`. The CLI prints a URL and the local port that it listens on. Forward that port to your own machine with `ssh -L` before you open the URL. Without a terminal, the CLI cannot ask which instance to use, so also pass `--api-url`.

To authenticate a script, set a token in the environment. A token in the environment overrides a stored token.

```bash
export ORCHARD_API_URL=https://orchard.example.com
export ORCHARD_API_TOKEN=<API_TOKEN>
```

To create a token, refer to [Manage API tokens](/account/tokens/).

## Choose an organization and project

Most commands act on an organization, a project, or an environment. Orchard uses the first value it finds, in the following order:

1. The `--org`, `--project`, and `--env` flags.
2. The `ORCHARD_ORG`, `ORCHARD_PROJECT`, and `ORCHARD_ENV` environment variables.
3. The saved context from `orchard use`.

To save a context, run the following commands:

```bash
orchard use org my-org
orchard use project my-app
orchard context show
```

To link a directory to a project, run `orchard link --project my-app` in that directory. The command writes `.orchard/project.json`. Commands that you run from that directory then use the project.

## Common commands

| Task                                                                                   | Command                              |
| -------------------------------------------------------------------------------------- | ------------------------------------ |
| List apps                                                                              | `orchard deploy list`                |
| [Scale an app](/deploy/scaling/#change-replicas)                                       | `orchard deploy scale <ID> 3`        |
| [Read or follow logs](/run/logs/)                                                      | `orchard logs <ID> -f`               |
| [Build and deploy the current directory](/deploy/deploy-from-terminal/)                | `orchard up`                         |
| [Write variables to `.env.orchard`](/run/environments/#pull-variables-to-a-local-file) | `orchard env pull`                   |
| List databases                                                                         | `orchard db list`                    |
| [Run a job](/run/jobs/)                                                                | `orchard job run <ID>`               |
| [Roll back an app](/deploy/rollbacks/)                                                 | `orchard deploy rollback <ID> --yes` |

## Use the CLI in scripts

The CLI writes JSON to stdout when stdout is not a terminal. To request JSON in a terminal, add `-o json`. Status and warnings go to stderr.

```bash
orchard deploy list -o json | jq -r '.[].name'
```

Destructive commands ask for confirmation in a terminal. Without a terminal, they fail with exit code `2` unless you pass `--yes`.

To block until a deploy finishes, add `--wait`:

```bash
orchard deploy rebuild <ID> --wait --timeout 15m
```

To list every command and flag as JSON, run the following command:

```bash
orchard commands -o json
```

### Exit codes

| Code  | Meaning                                                      |
| ----- | ------------------------------------------------------------ |
| `0`   | Success                                                      |
| `1`   | General or network error, or no token configured             |
| `2`   | Usage error, or a refused confirmation                       |
| `3`   | Authentication rejected (HTTP 401)                           |
| `4`   | Not found (HTTP 404)                                         |
| `5`   | Request rejected (other HTTP 4xx, including a missing scope) |
| `6`   | Rate limited (HTTP 429)                                      |
| `7`   | Server error (HTTP 5xx)                                      |
| `8`   | `--wait` reached its timeout                                 |
| `9`   | The build failed during a wait                               |
| `10`  | Pods are crash-looping or the rollout is unhealthy           |
| `130` | Interrupted                                                  |

## Related resources

- [CLI reference](/reference/cli/)
- [Code mode for agents](/agents-code-mode/)
- [Manage API tokens](/account/tokens/)
- [Use the terminal dashboard](/run/terminal-dashboard/)
- [Deploy from your terminal](/deploy/deploy-from-terminal/)
