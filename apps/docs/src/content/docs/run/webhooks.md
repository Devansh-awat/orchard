---
title: Webhooks
description: Trigger a deploy from outside Orchard.
sidebar:
  order: 8
---

Auto-deploy on push covers most cases. Webhook tokens cover the rest: a CI
pipeline that builds elsewhere, a release process that decides when to ship, or
any system that should be able to say "roll this out now".

## Creating one

On an app, create a **webhook token**. The token is shown once when created;
store it then, because it is not readable afterwards.

Each token belongs to one app, so revoking it affects nothing else.

## Triggering

```bash
curl -X POST https://your-orchard/apiv1/webhooks/deploy/<token>
```

The request triggers the same deploy path as a push: build if the app comes from
a repository, roll out, health-check, and keep the previous image available for
rollback.

## Revoking

Delete the token. Anything still using it stops working immediately, which is
the point. Rotate by creating a new token, updating the caller, then deleting the
old one.

## Notes

Treat a webhook token as a credential that can deploy your app. It belongs in
your CI system's secret store, not in a repository.

Inbound GitHub webhooks are handled by the GitHub App and are separate from
these; you do not configure those by hand.
