---
title: Notifications
description: Route deploy and crash events to Slack, Discord or a webhook.
sidebar:
  order: 7
---

Notifications have two halves: **channels** (where a message goes) and **rules**
(what is worth sending).

## Channels

A channel is a destination: a Slack webhook, a Discord webhook, or a plain HTTP
endpoint that receives JSON. Add one, send a **test** message to prove it works,
and it is available to rules.

A channel can belong to the whole organization or to a **single app**, which
keeps a noisy service out of everyone else's feed.

## Rules

A rule decides which events reach a channel: deploy succeeded, deploy failed,
app crashed, and so on. Scope it to an app or leave it organization-wide.

## Deliveries

Every attempt is recorded with its outcome, so a channel that quietly stopped
working is visible rather than silent. Failed deliveries can be replayed once the
destination is fixed.

## Notes

Webhook destinations are validated before they are saved, so an internal address
cannot be used to make the platform fetch something on your behalf.

Start with failures only. A rule that fires on every successful deploy is
muted within a week, and then the failures are muted too.
