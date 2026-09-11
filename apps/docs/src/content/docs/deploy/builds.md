---
title: Builds
description: How images get built, cached, and what to do when a build fails.
sidebar:
  order: 3
---

Builds run as jobs on your cluster, not on a build service somewhere else. Each
one clones the repo, builds the image with BuildKit, and pushes to the registry
the instance is configured with.

## The five steps

The progress page tracks the build as five steps, each with its own timing:

1. **Scheduling builder**: waiting for a node with capacity
2. **Building image**: BuildKit doing the work, with streaming logs
3. **Pushing image**: to the configured registry
4. **Creating app**: the Kubernetes objects
5. **Done**

Build status is tracked from the cluster's own job state rather than inferred
from a request, so a builder that dies is reported as failed instead of hanging
in "building" forever.

## Caching

Builders share a BuildKit cache so a second build of the same repo reuses layers.
Cache size is sized to the machine on installer-based setups; on the chart it is
a values setting. Tenants get eviction rather than an unbounded cache.

## Concurrency

How many builds run at once depends on available memory. On the one-command
installer it is derived from the box: under 8Gi RAM allows one, 8 to 16Gi allows
two, above that three. Extra builds queue.

A queued build is **accepted, not ignored**. It starts on its own when a slot
frees up, and the API says so: a rebuild that cannot start yet returns

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

Everything else on that response still describes the **previous** build, because
the new one has not produced anything yet. That is expected. Do not retry: a
second request supersedes the first rather than moving it up the queue, so a
retry loop can keep a deployment permanently at the back.

A deployment already building queues the same way, and says that instead.

## When a build fails

The logs are the answer, and they are kept. Common cases:

**Wrong build stage.** A multi-stage Dockerfile built at `base` produces an image
with no application. Check the build stage dropdown.

**Missing build-time secrets.** A stage that needs an API key to run a codegen
step will fail without it. Pass it as a build argument.

**The toolchain does not agree with itself.** Version skew inside the repo's own
Dockerfile, for example a bundler that cannot load a framework's compiled output.
Orchard reports it, but the fix is in the repo.

**Out of disk or cache pressure.** Shows up as I/O errors deep in a layer. If a
build dies quickly with a push error, read the BuildKit container's logs rather
than the pusher's; a fast failure there is usually the daemon dying, not a rate
limit.

A failed build leaves the previous version running. Nothing is torn down until a
new image is ready.
