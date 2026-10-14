# Community grafts

Grafts are Orchard's extensions. Official grafts live in this repo and are
signed by Orchard. Community grafts live in their author's own GitHub repo and
are signed with the author's own key. This folder is how a community graft gets
into the Extension Marketplace at `https://assets.orchard.my/registry`.

Every Orchard instance shows a community graft as "Community · by" followed by
your publisher name, and tells the admin, before they install it, that you
published it and not Orchard. Instances whose trust policy is `listed` (the
default), `taps` or `any` can install it; instances set to `official` cannot.

## Getting listed

Add one file, `registry/community/<id>.json`, in a pull request:

```json
{
  "id": "notes",
  "repo": "acme/orchard-notes",
  "publisher": "acme",
  "publicKey": "q1Wb0n1y8bWkS3xAq6v0n3vY1R4m8jYJb0nq8l2hX0E=",
  "homepage": "https://github.com/acme/orchard-notes"
}
```

- `id` is your graft's id from `graft.json`, and the file must be named after
  it. Ids are 2 to 48 lowercase letters, digits and hyphens, starting with a
  letter. Every instance has a single namespace, so an id that an official
  graft or another listing already uses is refused.
- `repo` is `owner/name` of the public GitHub repo you release from.
- `publisher` is the name shown next to your graft: 1 to 39 lowercase letters,
  digits and hyphens. Your GitHub login is a good choice.
- `publicKey` is your signing key's public half (see below).
- `homepage` is optional and must be an https address.

Nothing else goes in the file; unknown fields fail the check.

## Signing and releasing

Make a signing key once and keep the private half secret:

```sh
npx @orchardlabs/graft-sdk keygen graft-signing-key.pem
```

It prints the public key for your listing. Store the private key in your repo
as an Actions secret, base64 encoded (`base64 < graft-signing-key.pem`), for
example as `GRAFT_SIGNING_KEY`. Then let the graft-release action pack, sign
and attach your graft whenever you publish a GitHub Release:

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

The release must carry an asset named exactly `<id>-<version>.graft`, for
example `notes-1.2.0.graft`, where the version matches `graft.json`. Drafts and
prereleases are ignored, and so are any other assets.

## What happens next

The first listing of a graft is reviewed by an Orchard maintainer before it is
merged. We look at who you are, what the graft does and whether the id makes
sense. After that, updates are automatic: about once an hour the marketplace
reads your newest 20 releases and publishes every version it has not seen yet.
We do not review updates, and instances say so when they install your graft.

Each new version is checked before it is published, and skipped if it fails:

- the graft id matches your listing and the version matches the asset name,
- `engines.platform` and `engines.sdk` are set,
- every file matches its hash in `MANIFEST.json`, with nothing missing, nothing
  extra and no symlinks,
- `MANIFEST.sig` verifies against the `publicKey` in your listing,
- `database.adopts` is empty (only official grafts may take over Orchard's
  tables),
- no migration changes the `public` schema (run `graft doctor` to check),
- the file is at most 64 MiB.

A published version never changes. To ship a fix, release a new version.

Run `go run ./apps/registry validate-community -listings registry/community`
before you open the pull request; CI runs the same check.

## Changing a listing

Edit your file in a pull request. Changing `publicKey` replaces the key
instances check against, so versions signed with the old key stop verifying
once the change is merged. Release a new version signed with the new key right
after, so instances have something to upgrade to.

## Getting delisted

Delete your file in a pull request, or ask a maintainer to. Once it is merged,
the marketplace marks the listing as delisted and every version of it as
revoked. Instances stop trusting the graft, it disappears from search, and
nothing new is published for it. Already published files stay where they are so
instances can show what was there, but they no longer pass verification.

If a key leaks or a release turns out to be harmful, tell us and we will delist
the graft straight away.
