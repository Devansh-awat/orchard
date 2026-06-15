# Release & versioning

Conventional-commit–driven versioning for the whole monorepo, built on
[knope](https://knope.tech). It replaces release-please (which can't do
beta/release branch channels) and covers **both** the TS services and the Go
services from one config.

## What you get

- **One umbrella product version** — `orchard/vX.Y.Z` — that bumps by the
  largest change anywhere in the repo, with an aggregated root `CHANGELOG.md`.
- **Independent per-service versions**, each with its own tag and changelog:

  | service    | lang | tag             | version lives in            | changelog              |
  | ---------- | ---- | --------------- | --------------------------- | ---------------------- |
  | server     | TS   | `server/vX`     | `server/package.json`       | `server/CHANGELOG.md`  |
  | frontend   | TS   | `frontend/vX`   | `frontend/package.json`     | `frontend/CHANGELOG.md`|
  | gateway    | Go   | `gateway/vX`    | `gateway/go.mod` (comment)  | `gateway/CHANGELOG.md` |
  | cli        | Go   | `cli/vX`        | `cli/go.mod` (comment)      | `cli/CHANGELOG.md`     |
  | r2-proxy   | Go   | `r2-proxy/vX`   | `r2-proxy/go.mod` (comment) | `r2-proxy/CHANGELOG.md`|
  | **orchard**| —    | `orchard/vX`    | git tag only                | `CHANGELOG.md` (root)  |

- **Beta channel** on the `beta` branch → `X.Y.Z-beta.N` with an
  auto-incrementing counter. Maintenance lines (`1.x`, `1.2.x`) cut stable
  releases off their own history.
- **CI wiring**: computed versions tag the Docker images and pin the Helm
  chart (`version`/`appVersion` = umbrella, each `image.tag` = its service).

## How commits map to versions

Routing is **by commit scope**, not file path — so scope your commits:

```
feat(server): add login endpoint     # server: minor
fix(r2-proxy): handle nil binding    # r2-proxy: patch
perf(frontend): memoize tree         # frontend: patch
feat(cli)!: rename --org flag        # cli: major (or minor while 0.x)
feat: shared config change           # NO scope -> bumps EVERY service
chore(deps): bump lockfile           # no release
```

The umbrella always bumps by the highest rule seen across all of the above.
`feat`→minor, `fix`/`perf`→patch, `!` or a `BREAKING CHANGE:` footer→major
(while a package is pre-1.0, breaking/feat fold down to patch/minor per semver).
`chore`, `docs`, `refactor`, `test`, `style`, `ci`, `build` do **not** release.

Scopes are enforced on PRs by `.github/workflows/commitlint.yml`
(config: `commitlint.config.cjs`).

## Channels

| branch   | channel | example version  |
| -------- | ------- | ---------------- |
| `main`   | stable  | `1.4.0`          |
| `beta`   | beta    | `1.5.0-beta.0`   |
| `1.x`    | stable  | `1.4.1` (backport)|

Images are tagged `:<semver>` (only on a real release) plus `:latest`
(stable) or `:beta` (prerelease), and always `:sha-<sha>`.

## First-time setup (bootstrap)

No tags exist yet, so seed baselines once (knope computes deltas *from* tags).
Edit the starting versions in `bootstrap.sh` if you want, then:

```sh
bash tools/release/bootstrap.sh
git push --tags
```

After that, every push to `main` / `beta` runs the `release` workflow
automatically. The `version` job runs `tools/release/run-release.sh`, which:

1. picks the channel from the branch,
2. runs `knope release` (bump files + changelogs, commit, push, tag, GH release),
3. emits a JSON version manifest the `images` + `chart` jobs consume.

## Local usage

```sh
# preview what the next release would do (no writes), on the current branch
knope release --dry-run --verbose

# preview a beta cut
knope release --dry-run --prerelease-label beta

# current version of a package
knope get-version            # (single-package) — or read the tags:
git tag --list 'server/v*' | sort -V | tail -1
```

`knope` install (macOS): grab the `aarch64-apple-darwin` tarball from
<https://github.com/knope-dev/knope/releases> (pinned to `v0.23.0` in CI).

## Go version embedding

`cli`, `gateway`, and `r2-proxy` expose `var Version` (package `main`, except
the CLI's `cmd.Version`). Builds inject it via
`-ldflags "-X main.Version=<v>"`; `r2-proxy/Dockerfile` takes a `VERSION`
build-arg that CI sets from the manifest.
