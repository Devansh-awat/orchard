---
title: Builds
description: Orchard builds images in Kubernetes jobs on your cluster with BuildKit. Learn how build steps, caching, and the queue work, and fix common build failures.
sidebar:
  order: 3
---

Orchard runs each build as a Kubernetes job on your cluster. The job clones the repository, builds the image with BuildKit, and pushes it to the [registry configured on the instance](/operate/finishing-setup/#use-your-own-registry).

Orchard reads build status from the job. If a builder stops unexpectedly, the build shows as failed.

## Build steps

The build progress page shows these steps, with the logs for each one.

| Step                     | What happens                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| **Starting the builder** | The build waits for a slot and a node, and the builder pod starts. |
| **Cloning the repo**     | The builder clones the repository.                                 |
| **Building the image**   | BuildKit builds the image.                                         |
| **Pushing the image**    | The builder pushes the image to the registry.                      |
| **Rolling out**          | Kubernetes starts the new pods.                                    |

To cancel a running build, select **Cancel deployment** on the progress page.

## Caching

Builders share a BuildKit cache, so a later build of the same repository reuses layers. The installer sizes the cache from free disk. On a Helm install, set the size with `builders.localCache.size`.

## Concurrency and the queue

`MAX_CONCURRENT_BUILDS` limits how many builds run at once. The installer sets it from the machine's memory. For the values, refer to [Sizing](/start/install/#sizing).

One organization can run at most half of a pool's slots at once, so a single organization cannot keep everyone else waiting. A pool with 4 slots or fewer is not split. Set `MAX_CONCURRENT_BUILDS_PER_ORG` to change the limit, or to `0` for no limit. When builds are waiting, Orchard starts the one from the organization with the fewest running builds first, and takes the oldest request when organizations are level.

When all slots are busy, Orchard queues the build and starts it when a slot opens. The API reports this in the rebuild response:

```json
{
  "build": {
    "accepted": true,
    "started": false,
    "status": "queued",
    "running": 2,
    "slots": 2,
    "waiting": 1,
    "message": "All 2 build slots are busy on this instance. ..."
  }
}
```

The rest of that response still describes the previous build.

:::caution
Do not retry a queued build. A new request replaces the queued one and moves it to the back of the queue. A retry loop can keep an app waiting indefinitely.
:::

## Troubleshoot a failed build

A failed build leaves the previous version running. To read the logs, open the app and select **Build logs** in **Activity**, or run `orchard logs <id> --build`.

### The image has no application in it

**Cause:** The build used a stage that does not contain the application.

**Fix:** Go to **Settings** > **Source & build**. In **Build stage**, select the stage that contains your app.

### A build step fails because a key is missing

**Cause:** A stage needs a value at build time, such as an API key for a code generation step.

**Fix:** Add the value as a variable on the app. Orchard passes app variables to the build as [build arguments](/deploy/github/#build-arguments).

### Error: 401 Unauthorized when pulling a base image

**Cause:** The registry rejects anonymous pulls. `dhi.io` is one example.

**Fix:** Add these keys to the app as [secret variables](/run/environments/#secrets):

- `DHI_USERNAME` and `DHI_TOKEN` for Docker Hardened Images (`dhi.io`).
- `DOCKER_AUTH_CONFIG` for other registries. The value is a Docker config JSON whose `auths` map lists each registry.

Orchard uses these keys only for `FROM` and `COPY --from` pulls. It does not pass them as build arguments, and it does not add them to the running container.

### The build fails with I/O errors in a layer

**Cause:** The builder ran out of disk or the cache is full.

**Fix:** Increase the cache size. On an installer host, run `sudo orchardctl config set builders.localCache.size <size>G --apply`.

### The build fails quickly with a push error

**Cause:** The BuildKit daemon stopped. A fast failure here is usually not a registry rate limit.

**Fix:** Read the logs of the BuildKit container, not the pusher container.

### Could not schedule build pod: Insufficient memory

**Cause:** Memory requests on the node leave no room for the builder pod. Kubernetes counts requests, not actual usage.

**Fix:** Remove or shrink other workloads, or [add a node](/operate/nodes/).

### The build also fails on your machine

**Cause:** The Dockerfile has a problem of its own. Orchard runs your Dockerfile as written. It does not change your base image or your build steps.

**Fix:** Reproduce the build with `docker build` and fix it in the repository.

## Related resources

- [Roll back an app](/deploy/rollbacks/)
- [Deploy from GitHub](/deploy/github/)
- [Troubleshooting Orchard](/operate/troubleshooting/)
- [Deploy from an image](/deploy/image/)
