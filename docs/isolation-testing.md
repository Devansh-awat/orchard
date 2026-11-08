# Isolation testing

The control-plane isolation harness in `apps/server/test/isolation/` is the permanent proof for invariants I1 (org to org), I2 (project to project), I8 (observability scoping), I9 (identity confinement) and I12 (lifecycle) in `docs/tenancy-model.md`. It has two halves.

## 1. The route matrix (pure, runs in seconds)

`isolation-matrix.json` lists every HTTP route in the server and the grafts. It is generated from the Nest controller metadata (`@Param`, `@Query`, `@Body`), the TypeScript compiler API (id-like fields read from `@Body()` types and handlers) and `test/auth-coverage.snapshot.json`. Each entry records the auth class, the path params and the resource kind each one names (`id:deployment`), id-like query and body fields, and a decision:

| class             | meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `public`          | no credentials; nothing tenant-owned is reachable without a secret in the request    |
| `own-scope-only`  | no foreign resource id; returns or changes the caller's own data (lists, `/auth/me`) |
| `resource-scoped` | takes an org, project, deployment, database, token ... id in the path, query or body |
| `superadmin`      | refuses everything but instance superadmins                                          |
| `exempt`          | not replayed; needs a written `reason` of 20+ characters                             |

Run it: `pnpm --filter server test:isolation:matrix`. It fails when a route exists in code but not in the matrix, when a route disappeared, when a route is still `unclassified`, when its params or id fields changed, or when the class contradicts the auth class.

### Classifying a new route

1. Add the route and run `UPDATE_SNAPSHOT=1 pnpm --filter server test:auth-coverage`.
2. Run `UPDATE_ISOLATION_MATRIX=1 pnpm --filter server test:isolation:matrix`. New routes are written as `unclassified`.
3. Set `class` by hand. Anything that accepts an id belonging to a tenant is `resource-scoped`, including ids that arrive in the body or query. Use `exempt` only with a reason.
4. If the test reports `param ... has no resource kind`, teach `paramKind` in `inventory.ts` (and `kinds.ts`) what the id is, then seed that kind in `world.ts` so the route is replayed.

`ISOLATION_ACCEPT_PROPOSED=1` writes the generator's proposal instead of `unclassified`. Review every line of that diff.

## 2. The replay harness (needs Postgres)

`replay.test.ts` boots the real `AppModule` in process (Kubernetes pointed at a dead address, no Redis, throttler disabled), seeds two orgs with two projects each (environments, deployments, services, ingresses, databases, backups, checkpoints, jobs, stacks, registry credentials, env vars, webhook tokens, org-level channels, rules, status pages, SSO providers, SCIM tokens, user sessions, passkeys, git connections, tokens), and replays every `resource-scoped` and `own-scope-only` route as:

- no credentials
- the other org's owner as session, exec API token, MCP gateway grant
- a user in both orgs with a session, API token and MCP grant scoped to the other org
- a member and a project-restricted owner token of the other project in the same org
- a plain org member and a guest with no project
- lower roles: project viewer, read-only token, read-scoped MCP grant (mutations only)

Each route is sent three ways: with the victim's ids (`foreign`), with the caller's own parent and the victim's child or body ids (`mixed`, the confused-deputy case), and with random ids (`missing`). Every response is checked for:

- **denied**: 401/403/404 where denial is required
- **oracle**: status and message for an existing foreign id equal those for an unknown id
- **leak**: no id, name, slug, host, secret value or email of a tenant the caller is not in (ids the caller sent are ignored)
- **mutated**: no row touching another tenant changed (full row diff of the database)

Superadmin routes are replayed as tenants and must refuse. A control phase replays each route as its own owner (in a fresh world for mutating routes) so a denial cannot be an artifact of a bad request; it prints how many routes the owner reached.

Run it against a throwaway Postgres:

```bash
export TEST_DATABASE_URL=postgresql://orchard@127.0.0.1:54329/orchard
cd apps/server && pnpm exec prisma migrate deploy
pnpm test:isolation
ISOLATION_ONLY='^GET /deployments' pnpm test:isolation
ISOLATION_REPORT=/tmp/isolation.json pnpm test:isolation
```

It refuses `localhost:5432` unless `TEST_DATABASE_URL` is explicit (see `test/support/test-database.ts`). A full run takes about two minutes.

### Reading a failure

Each failure lists the finding kind, the principal, the variant, the exact request and an id such as `oracle | DELETE /deployments/:id | o2Session`.

- `allowed`: a principal that must be refused got a 2xx/3xx. Treat as a leak until proven otherwise.
- `error-reached`: a 5xx for a principal that must be refused. The handler ran, or crashed before authorizing.
- `leak`: the body contains another tenant's data. Check error messages first; they often interpolate ids.
- `oracle`: "exists but not yours" and "does not exist" answer differently. Make the denial path throw the same exception as the missing path.
- `mutated`: the request changed a row that belongs to someone else.

Fix the route and add nothing to the allowlist. If a finding is a reviewed false positive or a known open item, add its id to `isolation-exceptions.json` with `status` (`open` or `accepted`) and a `reason`. An entry that stops firing fails the run, so the list cannot rot.

## Not covered

- Graft routes (`greenhouse`, `forum`, `announcements`) are `exempt`: grafts are trusted by design.
- Privilege tiers inside one project (member against admin) are not asserted; only viewer, read-scope and non-members are.
- Pod exec, WebSocket upgrades and the ingress auth proxy are covered by their own suites.
- Observability query builders are covered by `logsql.test.ts` and `mcp-observability.test.ts`; the HTTP routes in front of them are replayed here.
