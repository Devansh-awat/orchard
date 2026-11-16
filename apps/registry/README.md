# registry

Publishes and serves Orchard's template catalogue and Extension Marketplace
(grafts) from an S3 bucket. The content it publishes lives in
[`registry/`](../../registry/README.md) and in the built-in templates under
`apps/server/src/templates/built-in`.

## Who runs it

The Orchard project, not each instance. It publishes the content behind
`https://assets.orchard.my/registry`, which every instance reads unless
`TEMPLATE_REGISTRY_URL` or `ORCHARD_GRAFT_MARKETPLACE_URL` points somewhere
else. An instance never runs this service.

You can run your own. Instances only trust signatures from the Orchard key, so
publish without `GRAFT_SIGNING_KEY` (the indexes go out unsigned) and set
`ORCHARD_REGISTRY_SIGNATURE=auto` on the instance. Refer to
[The community registry](https://docs.orchard.hackclub.com/run/templates/#the-community-registry).

## Commands

One binary, several subcommands. `registry help` prints the full list of
flags.

- `serve` (the default): serves the bucket over HTTP, read-only, with cache
  headers and `templates/<name>/latest/...` redirects to the newest version.
- `validate`, `publish`: check templates, then upload new versions and the
  catalogue. A published version is never overwritten.
- `validate-grafts`, `publish-grafts`: check packed `.graft` files, then
  publish them. Unsigned grafts are refused.
- `validate-community`, `sync-community`: check the listings in
  `registry/community`, then publish their grafts from the authors' GitHub
  releases.
- `version`

## Configuration

- `R2_ENDPOINT` (or `R2_ACCOUNT_ID` for Cloudflare R2), `R2_BUCKET`,
  `R2_ACCESS_KEY`, `R2_SECRET_KEY`: the bucket. Required by every command
  except the `validate` ones. Any S3-compatible store works.
- `R2_REGION`: signing region (default `auto`)
- `REGISTRY_PREFIX`: key prefix inside the bucket (default none)
- `REGISTRY_LISTEN`: listen address for `serve` (default `:8080`)
- `REGISTRY_PUBLIC_BASE_PATH`: path the registry is mounted at behind a proxy,
  such as `/registry`, used for `latest` redirects
- `GRAFT_SIGNING_KEY`: base64 of the PEM ed25519 private key that signs
  `templates/index.json`, `grafts/index.json` and community listings. Required
  for `sync-community`.
- `GITHUB_TOKEN`: read-only token for the GitHub API rate limit
  (`sync-community`)
- `GITHUB_API_URL`: GitHub API base URL (default `https://api.github.com`)

`GET /healthz` returns `ok`.

## Develop

```sh
cd apps/registry
go build ./...
go test ./...
go run . validate -templates ../../apps/server/src/templates/built-in -templates ../../registry/templates
```

## Release

The service and the content ship separately.

- The image: release-please versions it as `registry/vX.Y.Z` from
  `fix(registry):` and `feat(registry):` commits, and a release publishes
  `ghcr.io/hackclub/orchard/registry`.
- Templates: `.github/workflows/registry.yml` validates them on pull requests.
  It publishes from `main` when release-please cuts a `templates` or `server`
  release, every week, and when run by hand.
- Grafts: `release.yml` runs `publish-grafts` when a first-party graft is
  released. `grafts.yml` runs `sync-community` every hour.

Publishing uses the bucket credentials and `GRAFT_SIGNING_KEY` from the
`registry` GitHub environment.
