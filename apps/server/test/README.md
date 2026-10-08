# Server tests

Most suites here are pure: they build services with fakes and never open a
database. A few write real rows and need Postgres:

| Script                         | File                           |
| ------------------------------ | ------------------------------ |
| `pnpm test:apply-queue`        | `apply-queue.test.ts`          |
| `pnpm test:mirror`             | `mirror-engine.test.ts`        |
| `pnpm test:repo-link`          | `github-repo-link.test.ts`     |
| `pnpm test:rbac`               | `rbac.e2e.ts`                  |
| `pnpm test:rate-limit-postgres` | `rate-limit-postgres.test.ts` |

They get their client from `support/test-database.ts`, which refuses to run
when the database would be `localhost:5432` (on a developer machine that port is
usually a forward to production) or when no database is configured at all. Point
them at a throwaway Postgres instead:

```bash
docker run -d --name orchard-test-db -p 15432:5432 \
  -e POSTGRES_USER=orchard -e POSTGRES_PASSWORD=orchard -e POSTGRES_DB=orchard postgres:16
export TEST_DATABASE_URL=postgresql://orchard:orchard@127.0.0.1:15432/orchard
DATABASE_URL=$TEST_DATABASE_URL pnpm prisma migrate deploy
pnpm test:apply-queue
```

`TEST_DATABASE_URL` always wins over `DATABASE_URL`. `pnpm test:db-guard` covers
the guard itself.
