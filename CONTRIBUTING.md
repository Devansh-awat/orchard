# Contributing to Orchard

## Getting set up

Follow the Develop section in [README.md](README.md). The short version:
`pnpm install`, `docker compose -f docker-compose.dev.yml up -d`, copy the
`.env.example` files, run migrations + seed, `pnpm dev`, open
http://localhost:4000.

## Pull requests

- Branch from `main`, open PRs against `main`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  and are enforced by commitlint in CI (`feat:`, `fix:`, `chore:`, `ci:`, ...).
  Scope by app when it helps: `feat(cli): ...`.
- Releases are cut automatically by release-please from commit types, so the
  type you pick decides whether a service version bumps. Breaking changes need
  a `!` (`feat!:`) and a `BREAKING CHANGE:` footer.
- CI runs only the jobs for the apps you touched. Fork PRs run a prettier
  check instead of the auto-format bot; run
  `pnpm --filter frontend exec prettier --write .` before pushing frontend
  changes.

## Checks to run locally

```bash
pnpm lint                                  # eslint across the workspace
pnpm --filter frontend exec prettier --check .
pnpm --filter frontend check:design        # design-system guardrails
pnpm --filter server test:auth-coverage    # route/auth snapshot
cd apps/cli && go test ./...
```

New API endpoints must be added to the auth-coverage snapshot: run
`UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage` and commit the
updated `auth-coverage.snapshot.json` (the test fails with instructions if you
forget).

## Code style

- No code comments; write code that reads on its own (see AGENTS.md).
- Frontend work must follow `apps/frontend/DESIGN.md`: semantic tokens only,
  no raw hex colors, `ui/` components over legacy classes. `pnpm check:design`
  enforces the basics.
- Database changes go through Prisma migrations
  (`pnpm --filter server prisma:migrate`), one migration per PR.

## Reporting security issues

Please do not open public issues for security vulnerabilities. Email the
maintainers instead.
