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

Webhook tokens let an external system trigger a deploy without GitHub, which is
useful for a CI pipeline that wants to build elsewhere and then ask Orchard to
roll out.

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
