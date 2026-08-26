---
title: Deploy from an image
description: Run a container image directly, with no build step.
sidebar:
  order: 2
---

**New → Docker Image** skips the build entirely and runs an image you already
have. Useful for third-party software (`redis:7-alpine`, `nginx:alpine`), for
images built by your own CI, and for anything where Orchard building it adds
nothing.

## What you provide

| Field       | Notes                                                             |
| ----------- | ----------------------------------------------------------------- |
| Image       | Any reference the cluster can pull, including a private registry  |
| Port        | The port the process listens on inside the container              |
| Replicas    | How many copies                                                   |
| Environment | Variables the image needs                                         |
| Resources   | CPU and memory                                                    |
| Pull policy | Whether the image is fetched again every time a pod starts        |

Generating a URL is optional. Leave it off for workers, queue consumers and
anything with no HTTP surface.

## Private registries

If the image lives somewhere that needs credentials, the pull secret is
configured at the instance level by whoever operates Orchard. Tenants do not
manage registry credentials themselves.

## Updating the image

Changing the image tag on an existing app rolls it out like any other deploy, so
health checks and the rollback history apply.

Pushing a new image to the _same_ mutable tag is the case people trip over.
Orchard is not watching your registry, so nothing happens on its own. What
happens when you then restart depends on the pull policy:

- **Use cached** (`IfNotPresent`, the default): the node already has an image
  with that tag, so it reuses it. Restarting changes nothing, and your old build
  keeps serving. This is the "why is it still showing the old version" case.
- **Always re-pull** (`Always`): every pod start fetches the tag again, so
  **push, then Restart** picks up the new image.

So for a `:latest` workflow, set the pull policy to Always re-pull. Orchard
points this out on the image field when it spots a tag that can move.

Immutable tags are still the better habit where you control the build: a tag
that never moves makes rollbacks meaningful and costs nothing at pull time. If
you can, tag by commit or version and change the tag here instead.

None of this applies to apps built from GitHub. Those get a unique tag for every
build, so there is never a stale layer to reuse.
