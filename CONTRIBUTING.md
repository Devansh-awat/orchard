# Contributing to Orchard

## Getting set up

You will want Node 22.13+, pnpm 11, Go 1.26 and Docker.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d    # Postgres 16 + Redis

cp .env.example apps/server/.env                  # set JWT_SECRET, the rest boots as-is
cp apps/frontend/.env.example apps/frontend/.env

pnpm --filter server prisma:generate
pnpm --filter server prisma:migrate               # apply migrations
pnpm --filter server prisma:seed                  # demo data

pnpm dev                                          # frontend + server + gateway
```

Then open <http://localhost:4000>. The gateway proxies `/apiv1/*` to the API on 3001 and everything
else to Vite on 3000, so always use `:4000` or logins break in confusing ways.

The seed gives you `admin@orchard.dev` in the `orchard-demo` org. Sign in with an email OTP; codes
print to the server console when SMTP is not configured.

You do not need a Kubernetes cluster for UI or API work. The server boots without one, and deploy and
build features return 503 until you point `KUBECONFIG_PATH` at something. For UI work alone,
`pnpm dev:mock` runs the dashboard on port 3000 with an in-memory API and no backend.

Per service:

```bash
pnpm --filter frontend dev
pnpm --filter server dev
pnpm --filter landing dev    # marketing site  :5173
pnpm --filter docs dev       # documentation   :5174
cd apps/cli && go run .
```

## Where the code lives

```
apps/                  deployable units
  frontend             SvelteKit web app
  server               NestJS API + Prisma, plus orchardctl in hostctl/
  gateway              Go edge gateway
  cli                  Go CLI (`orchard`) and OpenTofu provider
  r2-proxy             Go storage proxy for database backups
  registry             Go template and graft registry
  fc-builder           Firecracker image builder
  landing              marketing site
  docs                 documentation site (Astro Starlight)
packages/              shared, importable code, never deployed
grafts/                first-party extensions
registry/              template and community graft content
infra/                 Helm chart, Kubernetes manifests, images
install/               one-command installer
docs/                  design and architecture notes
```

Each app, package and graft has its own README with how to run, test and ship it. To learn how the
system works before you change it, read [DEVELOPERS.md](DEVELOPERS.md). To add a template to the
gallery, follow [registry/README.md](registry/README.md).

## Commits

release-please reads your commits to decide versions and changelogs, so they follow
[Conventional Commits](https://www.conventionalcommits.org/) and commitlint checks them in CI.

- **`feat:`** you added a thing. Bumps the minor version (1.2.3 to 1.3.0)
- **`fix:`** you fixed a thing. Bumps the patch version (1.2.3 to 1.2.4)
- **`chore:`** boring maintenance. Dependencies, typos, readmes

Use those three, lowercase, in the infinitive ("add thing", not "added thing"), subject line only. The
diff says the rest.

```
feat(cli): add cool thingy
fix(server): stop thingy crashing on Tuesdays
chore: update readme
```

The scope picks the service that gets released, and the allowed scopes are in
`commitlint.config.cjs`. An unscoped `feat:` or `fix:` bumps every service. Mark a breaking change with
a `!` after the type or scope (`feat!:` or `feat(server)!:`). release-please reads the `!`, so the
subject line still carries everything and no footer is needed.

## License of contributions

Orchard is licensed under [AGPL-3.0](LICENSE). By opening a pull request, you agree that your
contribution is licensed under the same terms, and that you wrote it or otherwise have the right to
submit it.

## Pull requests

- Branch from `main`, open PRs against `main`. PRs are squash-merged or rebased; `main` has no merge
  commits.
- CI runs only the jobs for the apps you touched. Lint and format always run (oxlint + oxfmt). Fork
  PRs get a check-only format job; same-repo PRs auto-apply oxfmt. Run `pnpm format` before pushing
  if you are on a fork.
- `main` runs release-please. Each service is versioned on its own (`<service>/vX.Y.Z`), and only the
  services that got bumped build and publish their image to GHCR.

## Checks to run locally

```bash
pnpm lint                                         # oxlint + frontend design guardrails
pnpm format:check                                 # oxfmt across the workspace
pnpm --filter server test:auth-coverage           # route/auth snapshot, no database needed
pnpm --filter server test:isolation:matrix        # every route has a tenant isolation class
pnpm --filter frontend test
cd apps/<module> && go test ./...                 # for each Go module you touched
```

`pnpm --filter server test` runs every unit test, and `test:postgres` runs the suites that need a
database. Set `TEST_BASE` to a git ref to run only the test files that import, directly or not, a
file changed since that ref, as pull requests do in CI:

```bash
TEST_BASE=origin/main pnpm --filter server test
pnpm --filter server exec tsx --test test/<name>.test.ts
```

A change to anything that is not TypeScript, such as `schema.prisma`, `package.json` or a fixture,
runs every test. Pushes to `main` always run every test.

A few server suites write real rows and refuse to run against `localhost:5432`. See
[apps/server/test/README.md](apps/server/test/README.md) for pointing them at a throwaway Postgres.

## Generated files

Reference docs are generated from the thing they document: the OpenAPI contract, the CLI's command
tree, the MCP tool registry and `.env.example`. CI fails if they are stale, so regenerate in the same
change. [AGENTS.md](AGENTS.md) has the full table.

```bash
UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage    # after adding or changing a route
UPDATE_ISOLATION_MATRIX=1 pnpm --filter server test:isolation:matrix
pnpm --filter @orchard/contracts bootstrap
pnpm --filter @orchard/contracts generate
pnpm --filter docs generate
pnpm --filter @orchard/health sync                           # after changing packages/health
pnpm credits                                                 # after adding or upgrading a dependency
```

The isolation matrix writes new routes as `unclassified`. Give each one a class by hand, as
[docs/isolation-testing.md](docs/isolation-testing.md) describes. Run `pnpm credits` with the Go
version from the `go.mod` files, or every Go notice file changes.

## Third-party pins and advisories

Orchard ships pinned versions of its third-party components: the images in
`infra/charts/orchard/values.yaml`, the zot and cloudflared images and any add-on chart versions in
`install/install.sh`. The component list, the OSV.dev package for each one and its update class live
in `apps/server/hostctl/internal/commands` (`addons.go` and `images.go`), the same list that
`orchardctl update` uses on a host.

The `dependency-advisories` workflow checks those pins against OSV.dev every day, and on pull requests
that change them. It fails when a pinned version has a known advisory, because new installs start on
that version, and it tells you which pin to bump and whether hosts fix themselves first. To run it
locally:

```bash
cd apps/server/hostctl && go run ./cmd/advisorycheck
```

It exits `1` when a pin needs you and `3` when OSV.dev, a registry or a chart repository did not
answer. Add-on charts without a pin are checked at their newest release, which is what a new install
gets.

## Code style

- Lint with oxlint (`pnpm lint`) and format with oxfmt (`pnpm format`). ESLint and Prettier are not
  used.
- Don't add code comments; write code that reads on its own.
- Frontend work must follow `apps/frontend/DESIGN.md`: semantic tokens only, no raw hex colors, `ui/`
  components over legacy classes. `pnpm lint` runs the design check that enforces the basics.
- Database changes go through Prisma migrations (`pnpm --filter server prisma:migrate`), one migration
  per PR.

## Reporting security issues

Please do not open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for how
to report one privately.
