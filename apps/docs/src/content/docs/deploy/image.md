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

| Field       | Notes                                                            |
| ----------- | ---------------------------------------------------------------- |
| Image       | Any reference the cluster can pull, including a private registry |
| Port        | The port the process listens on inside the container             |
| Replicas    | How many copies                                                  |
| Environment | Variables the image needs                                        |
| Resources   | CPU and memory                                                   |

Generating a URL is optional. Leave it off for workers, queue consumers and
anything with no HTTP surface.

## Private registries

If the image lives somewhere that needs credentials, the pull secret is
configured at the instance level by whoever operates Orchard. Tenants do not
manage registry credentials themselves.

## Updating the image

Changing the image tag on an existing app rolls it out like any other deploy, so
health checks and the rollback history apply. Pushing a new image to the _same_
mutable tag does not trigger anything on its own: Orchard has no reason to
believe the tag moved. Trigger a rebuild, or use immutable tags.
