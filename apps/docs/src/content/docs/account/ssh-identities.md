---
title: SSH identities
description: Named public keys you can attach to sandboxes.
sidebar:
  order: 4
---

An SSH identity is a named public key on your account. Attach one to a
[sandbox](/run/sandboxes/) to reach it from your own terminal or point a local
editor at it.

## Adding a key

Add a public key and give it a name you will recognise later ("laptop",
"desktop"). Only the public half is ever sent; your private key stays where it
is.

### Importing from GitHub

If your keys are already on GitHub, import them:

```
github.com/<username>.keys
```

Orchard fetches that list and creates an identity per key, which saves pasting
them by hand.

## Removing a key

Deleting an identity **fails while it is attached to a sandbox**, on purpose:
otherwise you would silently lose access to a running environment. Detach it
first, then delete.

## Rotating

Add the new key, attach it, confirm you can connect, then remove the old one.
Doing it in that order means a mistake leaves you with a working way in.
