---
title: Configure setup and run scripts
description: Add a .orchard/greenhouse.json file to a repository so that Greenhouse prepares each new worktree and starts your app from the terminal dock.
sidebar:
  order: 6
---

Prepare each new worktree and start your app with one action. A new worktree has your tracked files only. It has no installed dependencies and no untracked files such as `.env`.

## 1. Add the configuration file

Commit a file named `.orchard/greenhouse.json` to the root of your repository:

```json
{
  "setup": "pnpm install --frozen-lockfile",
  "run": "pnpm dev --host 0.0.0.0 --port 5173",
  "ports": [5173]
}
```

Greenhouse reads the file from the session's worktree first, so a branch can change its own scripts. If the worktree has no file, Greenhouse reads the copy in the repository's main checkout. A file that is not valid JSON counts as empty.

## 2. Start a session

The setup script runs in the background when Greenhouse creates the worktree. Its output appears in the **Setup** tab of the terminal dock. If a session has not run its setup, the tab offers **Run setup**.

## 3. Start the run script

In the terminal dock, select the start control for the run script. Its output appears in the **Run** tab. Starting a script that is running restarts it.

Bind your dev server to `0.0.0.0` so that you can preview it. Refer to [Preview a session](/greenhouse/previews/).

The host and guests can start and stop run scripts. Everyone in the session can read the output.

## File reference

All keys are optional.

| Key     | Type                                                  | Description                                                                                       |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `setup` | String, or array of strings                           | Runs once, when Greenhouse creates the session's worktree.                                         |
| `run`   | String, array of strings, or object of named commands | Runs when someone starts it in the terminal dock.                                                  |
| `ports` | Array of numbers                                      | The ports your app serves on. Up to 10 ports from 1024 to 65535, except 2222, 4096, and 4097. They appear in the **Ports** tab before anything listens on them. On Kubernetes machines, you can preview them. |

An array joins with newlines into one script. Each script can be up to 64 KB. Greenhouse reads up to 64 KB of the file.

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

### Named commands

To run several long-running processes, make `run` an object. Each command has its own tab in the dock, and starts and stops on its own. An object can hold up to 8 commands.

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

| Field   | Description                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key     | The command's name. It starts with a lowercase letter or digit, and can contain lowercase letters, digits, and dashes, up to 24 characters.                                                                   |
| `run`   | The script, as a string or an array of lines. A command can also be a plain string, like `worker` in the example.                                                                                             |
| `label` | The name in the tab and the menu, up to 40 characters. The default is the key with its first letter capitalized and dashes replaced by spaces.                                                                |
| `icon`  | One of `play`, `server`, `database`, `globe`, `flask-conical`, `hammer`, `terminal`, `zap`, `box`, `bug`, `rocket`, `book-open`, `layers`, `radio`, `cpu`, `wrench`, `eye`, `sparkles`, `refresh-cw`, or `mail`. |

The first command is the one that the API starts when a request does not name a command.

## Script environment

Scripts run as the `dev` user in a login shell, with the session's worktree as the working directory. Variables from [attached projects](/greenhouse/projects/) are loaded. Greenhouse also sets these variables:

| Variable                 | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `ORCHARD_SESSION_ID`     | The session's ID.                                                        |
| `ORCHARD_WORKSPACE_PATH` | The session's worktree, for example `~/.worktrees/app/fix-login-a1b2c3`. |
| `ORCHARD_ROOT_PATH`      | The repository's main checkout, `~/<repo>`.                              |

Use `ORCHARD_ROOT_PATH` to copy untracked files into the worktree.

Each script runs in its own `tmux` session on the machine, so it keeps running when you close the browser. Output also goes to a log under `~/.orchard/sessions/<session-id>/`.

## Machine setup and session setup

Greenhouse has two kinds of setup script.

|          | Machine setup script                      | `setup` in `greenhouse.json`                  |
| -------- | ----------------------------------------- | --------------------------------------------- |
| Runs     | On first boot, and on later boots until it succeeds | Once per session, when its worktree is created |
| Location | The machine's settings                    | The repository                                |
| Use for  | Language runtimes, global tools, dotfiles | Dependencies, generated files, local config   |
| Log      | `~/.setup.log`                            | The **Setup** tab                             |

## Examples

A Vite app:

```json
{
  "setup": "npm ci",
  "run": "npm run dev -- --host 0.0.0.0 --port 5173",
  "ports": [5173]
}
```

A Python API:

```json
{
  "setup": ["python3 -m venv .venv", ". .venv/bin/activate && pip install -r requirements.txt"],
  "run": ". .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload",
  "ports": [8000]
}
```

## Related resources

- [Machines](/greenhouse/machines/#setup-script)
- [Preview a session](/greenhouse/previews/)
