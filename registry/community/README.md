# Community grafts

List a graft in the Extension Marketplace at `https://assets.orchard.my/registry`.

Grafts are Orchard's extensions. Official grafts live in this repository, and Orchard signs them. Community grafts live in their author's GitHub repository, and the author signs them.

Orchard shows a community graft as "Community · by" followed by your publisher name. Before an admin installs it, Orchard states that you published it, not Orchard. Instances with the trust policy `listed` (the default), `taps`, or `any` can install it. Instances with `official` cannot.

## Add a listing

Open a pull request that adds one file, `registry/community/<id>.json`:

```json
{
  "id": "notes",
  "repo": "acme/orchard-notes",
  "publisher": "acme",
  "publicKey": "q1Wb0n1y8bWkS3xAq6v0n3vY1R4m8jYJb0nq8l2hX0E=",
  "homepage": "https://github.com/acme/orchard-notes"
}
```

| Field       | Description                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Your graft's ID from `graft.json`. The file name must match it. 2 to 48 lowercase letters, digits, and hyphens, starting with a letter. An ID that an official graft or another listing uses is refused. |
| `repo`      | The `owner/name` of the public GitHub repository you release from.                                                                                                |
| `publisher` | The name shown next to your graft. 1 to 39 lowercase letters, digits, and hyphens. Your GitHub login is a good choice.                                            |
| `publicKey` | The public half of your signing key.                                                                                                                              |
| `homepage`  | Optional. An `https` address.                                                                                                                                     |

The check rejects unknown fields.

To run the same check as CI, run this command from the repository root:

```sh
go run -C apps/registry . validate-community -listings ../../registry/community -official ../../grafts
```

## Sign and release

1. Create a signing key:

   ```sh
   npx -p @orchardlabs/graft-sdk graft keygen graft-signing-key.pem
   ```

   The command prints the public key for your listing. Keep the private key secret.

2. Store the private key in your repository as an Actions secret named `GRAFT_SIGNING_KEY`, base64 encoded:

   ```sh
   base64 < graft-signing-key.pem
   ```

3. Add a workflow that packs, signs, and attaches your graft when you publish a GitHub Release:

   ```yaml
   name: release
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
             path: .
   ```

The release must have an asset named `<id>-<version>.graft`, for example `notes-1.2.0.graft`. The version must match `graft.json`. The marketplace ignores drafts, prereleases, and other assets.

## Review and updates

An Orchard maintainer reviews the first listing before merging it. The review covers who you are, what the graft does, and whether the ID is suitable.

About once an hour, the marketplace reads your newest 20 releases and publishes each version it has not seen. No one reviews updates, and instances state this when they install your graft.

The marketplace checks each new version, and skips a version that fails:

- The graft ID matches your listing, and the version matches the asset name.
- `engines.platform` and `engines.sdk` are set.
- Each file matches its hash in `MANIFEST.json`, with no missing files, extra files, or symlinks.
- `MANIFEST.sig` verifies against the `publicKey` in your listing.
- `database.adopts` is empty. Only official grafts can take over Orchard's tables.
- No migration changes the `public` schema. Run `graft doctor` to check.
- The file is at most 64 MiB.

A published version does not change. To ship a fix, release a new version.

## Change a listing

Edit your file in a pull request. Changing `publicKey` replaces the key that instances check against. Versions signed with the old key stop verifying once the change is merged. Release a new version signed with the new key immediately after, so that instances can upgrade to it.

## Remove a listing

Delete your file in a pull request, or ask a maintainer to delete it. After the merge, the marketplace marks the listing as delisted and each of its versions as revoked. Instances stop trusting the graft, it leaves search results, and nothing new is published for it. Published files stay in place, but they no longer pass verification.

If a key leaks or a release is harmful, contact a maintainer to delist the graft.
