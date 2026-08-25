---
title: Rollbacks
description: Every build is kept, so going back is one click.
sidebar:
  order: 7
---

The **Deploys** tab lists every image the app has run, newest first, with the
commit and the time. Roll back to any of them in one click.

A rollback is an ordinary deploy that happens to point at an older image, so it
goes through the same rolling update and the same health checks. It does not
revert your repository, and it does not undo database migrations. If a release
migrated the schema, rolling back the image leaves the new schema in place, which
is usually fine for additive migrations and a problem for destructive ones.

## Recovering from a bad deploy

1. Roll back to the last known good image.
2. Fix the repository.
3. Push, which builds and deploys forward again.

The image history is what makes step 1 fast, which is why images are kept rather
than pruned aggressively.

## Restarting

**Restart** recreates the pods on the same image. Reach for it when the process
is wedged rather than the release being wrong: a stuck connection pool, a leaked
file handle, a cache that needs clearing. If the image is the problem, restarting
just reproduces it.
