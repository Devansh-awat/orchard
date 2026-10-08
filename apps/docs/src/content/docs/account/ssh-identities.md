---
title: SSH identities
description: Named public keys that let you reach your Greenhouse machines over SSH.
sidebar:
  order: 4
---

An SSH identity is a named public key on your account. Every
[Greenhouse machine](/greenhouse/) you host trusts all of your identities, so any
of them gets you in from your own terminal or a local editor (see
[Open in your editor](/greenhouse/editors/)).

`orchard sandbox ssh-config --install` generates a key just for Orchard and
registers it as an identity for you, which is the quickest way to get started.

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

Deleting an identity **fails while it is attached to a machine**, on purpose:
otherwise you would silently lose access to a running environment. Switch the
machine to another identity first (machine settings, or
`orchard sandbox update <name> --identity <other>`), then delete.

## Rotating

Add the new key, attach it, confirm you can connect, then remove the old one.
Doing it in that order means a mistake leaves you with a working way in.
