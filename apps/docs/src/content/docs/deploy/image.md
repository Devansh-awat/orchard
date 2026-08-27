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

| Field       | Notes                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Image       | Any reference the cluster can pull, including a private registry         |
| Port        | The port the process listens on inside the container                     |
| Replicas    | How many copies                                                          |
| Environment | Variables the image needs                                                |
| Resources   | CPU and memory                                                           |
| Pull policy | Whether the image is fetched again every pod start. Automatic by default |

Generating a URL is optional. Leave it off for workers, queue consumers and
anything with no HTTP surface.

## Private registries

If the image lives somewhere that needs credentials, the pull secret is
configured at the instance level by whoever operates Orchard. Tenants do not
manage registry credentials themselves.

## Updating the image

Changing the image tag on an existing app rolls it out like any other deploy, so
health checks and the rollback history apply.

Pushing a new image to the _same_ mutable tag used to be the case people tripped
over. Orchard is not watching your registry, so nothing happens on its own, and
whether a restart picks up the new image depends on the pull policy.

That policy is now chosen for you. **Automatic** reads the tag:

- A tag that can move (`latest`, `main`, `stable`, a floating major like `17`, or
  no tag at all) gets `Always`, so **push, then Restart** works.
- A pinned tag or a digest gets `IfNotPresent`, since nothing can change under it
  and re-pulling would be wasted work.

Change the image and the policy follows the new tag.

You can still pin it. **Use cached** and **Always re-pull** override the choice
and stay put through an image change, because at that point it is your decision
rather than a guess. Pinning a moving tag to Use cached is the one combination
that will quietly serve a stale build, so the field says so.

Immutable tags are still the better habit where you control the build: a tag
that never moves makes rollbacks meaningful. If you can, tag by commit or version
and change the tag here instead.

None of this applies to apps built from GitHub. Those get a unique tag for every
build, so there is never a stale layer to reuse.
