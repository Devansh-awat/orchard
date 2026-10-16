---
title: Setup and run scripts
description: Use .orchard/greenhouse.json to prepare every new worktree and start your dev server with one click.
sidebar:
  order: 6
---

A fresh worktree has your code and nothing else: no `node_modules`, no `.env`,
no built assets. A `.orchard/greenhouse.json` file in your repository tells
Greenhouse how to fix that for every session, and how to start the app.

## The file

Commit it at `.orchard/greenhouse.json` in the repository root:

```json
{
  "setup": "pnpm install --frozen-lockfile",
  "run": "pnpm dev --host 0.0.0.0 --port 5173",
  "ports": [5173]
}
```

| Key     | Type                                                  | What it does                                                                                                                                                                                                                                                                                                            |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup` | string, or array of strings                           | Runs once, automatically, when a session's worktree is created.                                                                                                                                                                                                                                                         |
| `run`   | string, array of strings, or object of named commands | Runs when someone presses **Run** in the terminal dock. An object holds up to 8 named commands, each started and stopped on its own; see [Several commands](#several-commands).                                                                                                                                         |
| `ports` | array of numbers                                      | Declares the ports your app serves on: up to 10, from 1024 to 65535, not 2222 or 4096. They show in the **Ports** tab before anything listens on them, and on Kubernetes machines they can be previewed even when they are not one of the standard preview ports. Listening ports are detected on their own either way. |

All keys are optional. An array is joined with newlines, so it reads as a
multi-line script:

```json
{
  "setup": [
    "cp \"$ORCHARD_ROOT_PATH/.env\" .env 2>/dev/null || true",
    "pnpm install --frozen-lockfile",
    "pnpm --filter db migrate"
  ],
  "run": "pnpm dev"
}
```

Greenhouse reads the file from the session's worktree first, so a branch can
change its own scripts, and falls back to the copy in the repository's main
checkout. A file that is not valid JSON is treated as empty. Each script may be
up to 64 KB, and the file itself is read up to 64 KB.

## How scripts run

Scripts run as the `dev` user in a login shell (`bash -l`), with the session's
worktree as the working directory, so your profile, `PATH` and any
[attached project](/greenhouse/projects/) variables are loaded. These are also
set:

| Variable                 | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `ORCHARD_SESSION_ID`     | The session's id.                                                        |
| `ORCHARD_WORKSPACE_PATH` | The session's worktree, for example `~/.worktrees/app/fix-login-a1b2c3`. |
| `ORCHARD_ROOT_PATH`      | The repository's main checkout, `~/<repo>`.                              |

`ORCHARD_ROOT_PATH` is the place to copy untracked files from: an `.env` that is
not in git, a large cache, a local certificate.

Each script runs in its own `tmux` session on the machine, so it keeps running
when you close the browser, and its output is also written to a log under
`~/.orchard/sessions/<session-id>/`.

### Setup

The setup script starts on its own right after the worktree is created, in the
background. The session is usable straight away; the agent can start before
setup finishes. Its output streams into the dock's **Setup** tab, and its state is
one of **running**, **done** or **failed** (with the exit code).

### Run

**Run** starts the run script in the dock's **Run** tab and the button turns into
a stop button while it is running. Starting it while it is already running
restarts it, so only one run script per session runs at a time. Starting and stopping need guest access
or higher; everyone can watch the output.

The run script is the natural home for a dev server. Bind it to `0.0.0.0`, not
`localhost`, on one of the preview ports, or a port you list under `ports`, so you
can open it from the **Ports** tab; see [Previews and ports](/greenhouse/previews/).

### Several commands

When a project needs more than one long-running process, make `run` an object.
Each key names a command, and each command gets its own tab in the dock and its
own start and stop:

```json
{
  "setup": "pnpm install --frozen-lockfile",
  "run": {
    "dev": { "run": "pnpm dev --host 0.0.0.0 --port 5173", "label": "Dev server", "icon": "globe" },
    "db": { "run": "docker compose up db", "label": "Database", "icon": "database" },
    "worker": "pnpm worker"
  },
  "ports": [5173]
}
```

| Field   | What it does                                                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key     | The command's name: lowercase letters, digits and dashes, up to 24 characters.                                                                                                                                  |
| `run`   | The script, a string or an array of lines. A command can also be just the string, like `"worker"` above.                                                                                                        |
| `label` | What the tab and menu show. Defaults to the key.                                                                                                                                                                |
| `icon`  | One of `play`, `server`, `database`, `globe`, `flask-conical`, `hammer`, `terminal`, `zap`, `box`, `bug`, `rocket`, `book-open`, `layers`, `radio`, `cpu`, `wrench`, `eye`, `sparkles`, `refresh-cw` or `mail`. |

With more than one command, **Run** opens a menu to start or stop each one, or
all of them at once. The first command is the one the API and CLI start when
they do not name one.

If a session never ran its setup, the **Setup** tab offers **Run setup** instead
of waiting.

## Machine setup versus session setup

There are two kinds of setup, and they solve different problems.

|          | Machine setup script                      | `setup` in `greenhouse.json`                   |
| -------- | ----------------------------------------- | ---------------------------------------------- |
| Runs     | Once per machine, on its first boot       | Once per session, when its worktree is created |
| Lives    | In the machine's settings                 | In the repository, versioned with the code     |
| Good for | Language runtimes, global tools, dotfiles | Dependencies, generated files, local config    |
| Log      | `~/.setup.log`                            | The dock's **Setup** tab                       |

## Example: a Vite app

```json
{
  "setup": "npm ci",
  "run": "npm run dev -- --host 0.0.0.0 --port 5173",
  "ports": [5173]
}
```

## Example: a Python API

```json
{
  "setup": ["python3 -m venv .venv", ". .venv/bin/activate && pip install -r requirements.txt"],
  "run": ". .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload",
  "ports": [8000]
}
```

## Example: a monorepo with a database

```json
{
  "setup": ["pnpm install --frozen-lockfile", "pnpm --filter server prisma generate"],
  "run": "pnpm --filter web dev --port 3000",
  "ports": [3000]
}
```

With a [project attached](/greenhouse/projects/), `DATABASE_URL` and the
environment's variables are already in the shell when this runs.
