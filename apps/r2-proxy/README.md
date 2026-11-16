# r2-proxy

The backup proxy. An S3 gateway that sits between tenant databases and the
instance's object storage, so the real storage credentials never reach a
tenant namespace.

Despite the name it works with any S3-compatible store, not only Cloudflare R2.

## Who runs it

Every Orchard instance. The Helm chart deploys it by default (`r2Proxy.enabled`)
in the `orchard-r2-proxy` namespace, and the one-command installer runs it in
front of the bundled object store.

## How it works

Each database (a CloudNativePG cluster) gets its own access key and secret.
Those are fake: they only mean something to this proxy. When barman sends a
request, the proxy:

1. Looks up the access key in Orchard's Postgres (`databases` and
   `storage_access_keys`). Lookups are cached for 60s, misses for 5s.
2. Verifies the SigV4 signature against that key's secret.
3. Checks the request against the key's bucket and prefix
   (`<namespace>/<cluster>/`), and allows only the S3 operations barman and
   the build cache use: HEAD bucket, HEAD/GET/PUT/DELETE object, multi-delete,
   list objects and multipart uploads.
4. Re-signs the request with the real credentials and streams it upstream.

Restore and recovery jobs get short-lived keys that can read the source
database's prefix and write only their own. When the build cache goes through
the proxy (`BUILDKIT_S3_VIA_PROXY`), each build gets a key for its project's
cache prefix.

The proxy connects to Postgres as the read-only `orchard_r2_proxy` role.

## Configuration

- `PROXY_LISTEN`: listen address (default `:9000`)
- `DATABASE_URL`: Orchard's Postgres. Required.
- `R2_ENDPOINT`: upstream S3 endpoint. Optional when storage is set in the UI.
- `R2_REGION`: signing region (default `auto`)
- `R2_PATH_STYLE`: `false` sends `<bucket>.<host>` instead of `<host>/<bucket>`
  (default `true`)
- `R2_ACCESS_KEY`, `R2_SECRET_KEY`: the real credentials. Required when
  `R2_ENDPOINT` is set.
- `DEFAULT_BACKUP_BUCKET`: bucket for organizations with no backup storage of
  their own
- `ALLOWED_BUCKETS`: comma-separated buckets the platform credentials serve
  (default `DEFAULT_BACKUP_BUCKET`). With `R2_ENDPOINT` set and no bucket named
  here or in `DEFAULT_BACKUP_BUCKET`, the proxy refuses to start.
- `STORED_UPSTREAMS_FILE`: JSON the server writes when storage is set under
  Instance admin or with `orchardctl backups s3` (default
  `/etc/r2-proxy/stored/upstreams.json`). Re-read every 15 seconds.

In the chart these come from `r2Proxy.*` in
[`values.yaml`](../../infra/charts/orchard/values.yaml).

`GET /healthz` returns `ok`.

## Develop

```sh
cd apps/r2-proxy
go build ./...
go test ./...
```

The tests in `main_test.go` cover the authorization rules. Run them after any
change to `authorizeOperation` or the request checks around it.

## Release

release-please versions it as `r2-proxy/vX.Y.Z` from `fix(r2-proxy):` and
`feat(r2-proxy):` commits. A release builds the `Dockerfile` and publishes
`ghcr.io/hackclub/orchard/r2-proxy`. The chart pins the tag in
`r2Proxy.image.tag`.

## Docs

- [Backups](https://docs.orchard.hackclub.com/data/backups/)
- [Add S3 storage](https://docs.orchard.hackclub.com/operate/storage/)
- [Security and isolation](https://docs.orchard.hackclub.com/operate/security/)
