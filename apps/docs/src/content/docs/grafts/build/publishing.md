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

## Running a tap

A tap is the simplest way to share several grafts: a folder on any https host
that people add once and then install from by name.

```sh
graft tap init ./my-tap --name acme --key ~/.config/graft/key.pem
graft pack --key ~/.config/graft/key.pem
graft tap add ./my-tap notes-0.1.0.graft
```

Upload `./my-tap` anywhere (GitHub Pages, R2, S3) and tell people:

```sh
sudo orchardctl graft tap add acme https://acme.dev/orchard
sudo orchardctl graft add acme/notes --apply
```

`tap add` refuses an artifact that is not signed with the tap's key, and a
published version can never be replaced with different bytes: bump the version
instead.

## Listing it as a community graft

Community grafts appear in the [Extension Marketplace](https://orchard.my/extensions)
next to Orchard's own, labelled with who publishes them. The code stays in your
own repository:

1. Generate a key with `graft keygen` and keep the private half as a GitHub
   Actions secret.
2. Release with the graft-release action, which packs, signs and attaches
   `<id>-<version>.graft` to each GitHub Release:

   ```yaml
   on:
     release:
       types: [published]
   jobs:
     graft:
       runs-on: ubuntu-latest
       permissions:
         contents: write
       steps:
         - uses: actions/checkout@v4
         - uses: hackclub/orchard/.github/actions/graft-release@main
           with:
             key: ${{ secrets.GRAFT_SIGNING_KEY }}
   ```

3. Open a pull request adding one file, `registry/community/<id>.json`, to the
   Orchard repository with your repository, your publisher name and your public
   key. The format is in `registry/community/README.md`.

A maintainer reviews the first listing. After that every new release is picked
up within the hour, checked automatically (signature, file hashes, no changes to
Orchard's own tables) and published without anyone in the loop. A release that
fails a check is skipped and the previous version stays available.

## Official grafts

Official grafts live in the
[`grafts/` directory](https://github.com/hackclub/orchard/tree/main/grafts) of the
Orchard repository and are signed with Orchard's own key. CI runs
`graft doctor`, packs every graft, and on merge signs new versions with Orchard's
key and publishes them. Published versions never change, so every update needs a
new `version`. You don't bump it by hand: each graft is a release-please
component, so `feat:` and `fix:` commits that touch it add it to the next
release pull request, which bumps `package.json` and `graft.json` together.
Merging that pull request publishes the new version. Add yours to
`release-please-config.json` and `.release-please-manifest.json` the same way
`grafts/greenhouse` is.

Every version lists the Orchard versions it works with (`engines.platform`), and
`orchardctl` installs the newest one that matches the instance, so older
instances keep getting the last version that works for them.
