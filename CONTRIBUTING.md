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

To learn how the system works before you change it, read [DEVELOPERS.md](DEVELOPERS.md).

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

## Sign your commits

Orchard uses the [Developer Certificate of Origin](DCO). Signing off a commit certifies that you
wrote it or otherwise have the right to submit it under the project's license. Add the line with `-s`:

```bash
git commit -s -m "fix(server): stop thingy crashing on Tuesdays"
```

Git adds `Signed-off-by: Your Name <you@example.com>`, using your configured name and email. It must
match the commit's author email, and it is the only thing that goes in the commit body. A check on
each pull request verifies it. If you forgot, sign off the whole branch and force-push it:

```bash
git rebase --signoff origin/main
git push --force-with-lease
```

## Pull requests

- Branch from `main`, open PRs against `main`.
- CI runs only the jobs for the apps you touched. Lint and format always run (oxlint + oxfmt). Fork
  PRs get a check-only format job; same-repo PRs auto-apply oxfmt. Run `pnpm format` before pushing
  if you are on a fork.
- `main` runs release-please. Each service is versioned on its own (`<service>/vX.Y.Z`), and only the
  services that got bumped build and publish their image to GHCR.

## Checks to run locally

```bash
pnpm lint                                  # oxlint + frontend design guardrails
pnpm format:check                          # oxfmt across the workspace
pnpm --filter server test:auth-coverage    # route/auth snapshot, no database needed
cd apps/cli && go test ./...
```

A few server suites write real rows and refuse to run against `localhost:5432`. See
[apps/server/test/README.md](apps/server/test/README.md) for pointing them at a throwaway Postgres.

## Generated files

Reference docs are generated from the thing they document: the OpenAPI contract, the CLI's command
tree, the MCP tool registry and `.env.example`. CI fails if they are stale, so regenerate in the same
change. [AGENTS.md](AGENTS.md) has the full table.

```bash
UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage    # after adding or changing a route
pnpm --filter @orchard/contracts bootstrap
pnpm --filter @orchard/contracts generate
pnpm --filter docs generate
pnpm credits                                                 # after adding or upgrading a dependency
```

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
