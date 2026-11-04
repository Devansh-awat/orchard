---
title: Publish a graft
description: Sign an Orchard graft, share it from an https address or a tap, and list it in the Extension Marketplace as a community graft.
sidebar:
  order: 6
---

Share a graft with other Orchard instances. You can publish in three ways:

- From any `https` address.
- From a tap: your own catalog of grafts.
- From the Extension Marketplace, as a community graft.

## Sign a graft

A packed `.graft` is a tar.gz file with `graft.json`, the built code, migrations, a `MANIFEST.json` listing the SHA-256 of each file, and `MANIFEST.sig`, an ed25519 signature over that list.

```sh
graft keygen ~/.config/graft/key.pem
graft pack --key ~/.config/graft/key.pem
```

The command prints the public key. Operators add it to `graftSettings.keys` to trust your grafts.

In CI, set `GRAFT_SIGNING_KEY` to the base64 of the private key, instead of passing `--key`.

## Share a graft from an https address

1. Upload the `.graft` file to an `https` address. Use a separate address for each version.
2. Give operators this command:

   ```sh
   sudo orchardctl graft add https://example.com/snippets-0.1.0.graft
   ```

   For Helm values, they use the entry that `graft pack` printed, with `source` set to the address.

The digest pins the exact file. If the file at the address changes, installs fail.

## Run a tap

A tap is a folder on an `https` host that people add once and then install from by name.

1. Create the tap:

   ```sh
   graft tap init ./my-tap --name acme --key ~/.config/graft/key.pem
   ```

2. Pack a graft with the same key, and add it to the tap:

   ```sh
   graft pack --key ~/.config/graft/key.pem
   graft tap add ./my-tap notes-0.1.0.graft
   ```

3. Upload `./my-tap` to a static host such as GitHub Pages, R2, or S3.
4. Give operators these commands:

   ```sh
   sudo orchardctl graft tap add acme https://acme.dev/orchard
   sudo orchardctl graft add acme/notes --apply
   ```

`graft tap add` refuses a file that is not signed with the tap's key. It also refuses different bytes for a published version. Bump the version instead.

## List a community graft

Community grafts appear in the [Extension Marketplace](https://orchard.my/extensions), labeled with their publisher. The code stays in your own repository.

1. Run `graft keygen`, and store the private key as a GitHub Actions secret.
2. Add a workflow that packs, signs, and attaches `<id>-<version>.graft` to each GitHub Release:

   ```yaml
   on:
     release:
       types: [published]
   permissions:
     contents: write
   jobs:
     graft:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: hackclub/orchard/.github/actions/graft-release@main
           with:
             key: ${{ secrets.GRAFT_SIGNING_KEY }}
   ```

3. Open a pull request that adds `registry/community/<id>.json` to the Orchard repository. For the file format, refer to [`registry/community/README.md`](https://github.com/hackclub/orchard/blob/main/registry/community/README.md).

A maintainer reviews the first listing. After that, the marketplace checks for new releases every hour. It checks the signature, the file hashes, and that migrations do not change Orchard's tables. It then publishes the release with no further review. A release that fails a check is skipped, and the previous version stays available.

## Publish an official graft

Official grafts live in the [`grafts/` directory](https://github.com/hackclub/orchard/tree/main/grafts) of the Orchard repository. CI runs `graft doctor` and packs each graft. On merge, CI signs new versions with Orchard's key and publishes them.

Published versions do not change, so each update needs a new `version`. Each graft is a release-please component. `feat:` and `fix:` commits that touch it add it to the next release pull request, which bumps `package.json` and `graft.json`. Merging that pull request publishes the new version.

To add a graft, add it to `release-please-config.json` and `.release-please-manifest.json`, like `grafts/greenhouse`.

## Version compatibility

Each version lists the Orchard versions it works with in `engines.platform`. `orchardctl` installs the newest version that matches the instance.

## Related resources

- [Install grafts](/grafts/install/)
- [Get started](/grafts/build/quickstart/)
