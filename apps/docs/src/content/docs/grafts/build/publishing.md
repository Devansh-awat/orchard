---
title: Publishing
description: Sign a graft, share it, and get it into the Extension Marketplace.
sidebar:
  order: 6
---

A packed `.graft` is a tar.gz with `graft.json`, the built code, migrations, a
`MANIFEST.json` listing the sha256 of every file, and `MANIFEST.sig`, an ed25519
signature over that list. Orchard checks both before it runs anything.

## Signing

```sh
graft keygen ~/.config/graft/key.pem
graft pack --key ~/.config/graft/key.pem
```

The printed public key is what operators add to `graftSettings.keys` to trust
your grafts. In CI, pass the private key base64 encoded in `GRAFT_SIGNING_KEY`
instead of `--key`.

## Sharing it yourself

Put the `.graft` anywhere served over https. Operators install it with:

```sh
sudo orchardctl graft add https://example.com/snippets-0.1.0.graft
```

or the Helm entry `graft pack` printed, with `source` set to that address. The
digest pins the exact file, so changing what is at the address breaks installs
instead of silently shipping different code: publish every version at its own
address.

## The Extension Marketplace

The [Extension Marketplace](https://orchard.my/extensions) publishes the grafts
in the [`grafts/` directory](https://github.com/hackclub/orchard/tree/main/grafts)
of the Orchard repository. Open a pull request adding yours. CI runs
`graft doctor`, packs every graft, and on merge signs new versions with Orchard's
key and publishes them. Published versions never change: bump `version` in
`graft.json` to ship an update.

Every version lists the Orchard versions it works with (`engines.platform`), and
`orchardctl` installs the newest one that matches the instance, so older
instances keep getting the last version that works for them.
