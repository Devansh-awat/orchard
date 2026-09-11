---
title: Deploy from GitHub
description: Connect a repository and let every push deploy itself.
sidebar:
  order: 1
---

## Linking GitHub

Orchard connects through a GitHub App. An instance admin creates it once using
the **manifest flow**: Orchard produces the manifest, GitHub creates the app, and
the credentials are handed back automatically.

Each person then links their own GitHub account. Repository access is per user:
Orchard can only list and build the repositories your account granted the app.
That is why two people in the same project can see different repository lists.

If GitHub removes an installation on its side, Orchard notices and marks it
suspended rather than retrying forever.

## Creating the app

**New → GitHub Repository**, then pick the repository and branch. Orchard reads
the repo and pre-fills:

| Field                 | Detected from                                            |
| --------------------- | -------------------------------------------------------- |
| Build method          | A `Dockerfile` if present, otherwise framework detection |
| Dockerfile path       | The file it found                                        |
| Build stage           | The stages declared in the Dockerfile                    |
| Port                  | `EXPOSE`, or the framework's default                     |
| Environment variables | `ENV` lines in the image                                 |

**Check the build stage.** For a multi-stage Dockerfile the last stage is usually
the one you want (`runner`, `runtime`, `production`). The dropdown defaults to the
first stage, which on a multi-stage build is normally just a base image with no
application in it.

`Build from the repository root` matters when the Dockerfile copies files from
outside its own directory, which is common in monorepos.

## Auto-deploy

Once linked, pushes to the selected branch trigger a build and deploy. Turn it
off per app if you would rather deploy manually.

**The App has to be installed on that specific repository.** Enabling
auto-deploy without it is refused, with a message naming the fix, because a push
to a repo the App cannot see never reaches Orchard and there is nothing to
report when it does not.

The case that catches people: an App installed with **only select
repositories** does not pick up a repository created _after_ the install. The
account shows the App as installed, the repo looks fine, and no webhook ever
arrives. Add the repo to the selection in the App's settings.

If auto-deploy looks switched on but pushes build nothing, check the auto-deploy
status. `enabled` is what you asked for; `deliverable` is what will actually
happen, and it is only true when the App is installed on the repo **and** this
app is bound to that installation. When it is false, the status says why.

Webhook tokens let an external system trigger a deploy without GitHub, which is
useful for a CI pipeline that wants to build elsewhere and then ask Orchard to
roll out.

### Watch paths

By default every push to the branch builds. In a monorepo that means the API
rebuilds when someone edits the marketing site. Watch paths narrow it: the app
only builds when the push changes a file matching one of them.

```
apps/api/**
packages/shared/**
package.json
!**/*.md
```

- One glob per line, matched against every file changed by the push.
- `**` crosses directories, `*` stays inside one segment, and `{a,b}` is an
  alternation, so `apps/**/*.{ts,tsx}` works.
- A bare directory such as `apps/api` covers everything under it.
- A line starting with `!` excludes, and an exclude always beats an include. A
  list of only excludes watches everything else.
- Leave the list empty to build on every push.

Set them under Settings, Deploy behavior, or from the CLI:

```bash
orchard deploy auto-deploy enable <id> --branch main --path 'apps/api/**' --path '!**/*.md'
```

Pass `--path ""` to clear the list. When Orchard cannot tell what a push
changed, which happens on very large pushes, it builds rather than skipping.

## Build arguments

Values injected as build arguments land **above** the user's own `ENV` lines in
the generated Dockerfile, so an `ENV` in the repo wins over an injected argument
of the same name. Injected arguments also propagate into derived stages, so a
value set for the builder is visible in stages that build `FROM` it.

## What Orchard does not do

It runs exactly what your Dockerfile says. It does not patch your build, swap
your base image, or add a package manager. If the build fails in Orchard and the
Dockerfile is unchanged, it almost certainly fails locally too. That is
deliberate: a build that only works on the platform is a build you cannot debug.
