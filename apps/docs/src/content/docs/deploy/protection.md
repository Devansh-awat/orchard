---
title: Deployment protection
description: Put an auth wall in front of a public app so staging is not public.
sidebar:
  order: 8
---

An app with a public URL is public. Protection puts an authentication wall in
front of it, so only people who can sign in to your Orchard instance reach the
app behind it.

This is what makes a staging environment safe to leave running without inventing
a second authentication system inside the app.

## How it works

Requests to a protected hostname hit Orchard's proxy first. Unauthenticated
visitors get the sign-in page; authenticated ones are passed through to the app.
The app itself needs no changes and sees ordinary traffic.

## Public paths

Some routes have to stay reachable: webhook receivers, health endpoints, OAuth
callbacks. Configure those as **public paths** and they skip the wall while
everything else stays behind it.

Get this right before pointing a payment provider or a GitHub webhook at a
protected app, otherwise the sender is met with a login page and the delivery
fails.

## Limits

Protection covers HTTP. Raw TCP and UDP ports are not proxied and are not
protected by it.
