# Server

The Orchard API. NestJS with Prisma on Postgres. It serves the dashboard, the CLI and the MCP server
under `/apiv1`, keeps a copy of cluster state in Postgres, and makes the changes Orchard asks of
Kubernetes.

In development it listens on `:3001` and the gateway in `apps/gateway` puts it behind `:4000`. In a
cluster the Helm chart in `infra/charts/orchard` runs it.

## Layout

- `src/auth`: sessions, tokens and authorization.
- `src/engine`: the cluster mirror. Informers list and watch every object Orchard manages.
- `src/apply`: the apply queue that carries most writes to the cluster.
- `src/kubernetes`: Kubernetes orchestration.
- `src/docker`: image builds.
- `src/projects`: tenant resources.
- `src/mcp`: the MCP server.
- `prisma/`: the schema, migrations and seed.
- `hostctl/`: `orchardctl`, the commands installed on an Orchard host. It is Go, has its own
  [README](hostctl/README.md), and ships in the server image, so a change there is a server change.
- `test/`: the test suites.

[DEVELOPERS.md](../../DEVELOPERS.md) explains how the engine, the apply queue, leases and tenancy
fit together. Read it before changing any of them.

## Running it

Follow the setup in [CONTRIBUTING.md](../../CONTRIBUTING.md), then:

```bash
pnpm --filter server dev
```

The server needs Postgres and `JWT_SECRET` to boot. Redis and Kubernetes are optional. Without a
cluster, deploy and build features return 503 until `KUBECONFIG_PATH` points at one. Every variable
is documented in [`.env.example`](../../.env.example).

Database scripts:

```bash
pnpm --filter server prisma:generate      # regenerate the client
pnpm --filter server prisma:migrate       # create and apply a migration
pnpm --filter server prisma:seed          # demo data
pnpm --filter server prisma:studio
pnpm --filter server prisma:check-drift   # needs SHADOW_DATABASE_URL
```

Read the migration rules in [AGENTS.md](../../AGENTS.md) before you commit a migration.

To run the MCP server on its own:

```bash
pnpm --filter server mcp          # stdio
pnpm --filter server mcp:remote   # HTTP on MCP_PORT, default 3100
```

## Tests

There is no single test script. Each suite has a `test:*` script in `package.json`, and you can run
any file directly:

```bash
pnpm --filter server test:auth-coverage
pnpm --filter server exec tsx --test test/health-sync.test.ts
```

Most suites are pure. The few that write real rows refuse to run against `localhost:5432`, because
that port is often a forward to production. [test/README.md](test/README.md) shows how to point them
at a throwaway Postgres with `TEST_DATABASE_URL`.

`test/isolation/` replays routes as another tenant. [docs/isolation-testing.md](../../docs/isolation-testing.md)
explains how to classify a new route.

For `orchardctl`:

```bash
cd apps/server/hostctl && go test ./...
```

## Generated files

A new or changed route needs a new auth-coverage snapshot and regenerated contracts and docs. The
full table of what to regenerate and when is in [AGENTS.md](../../AGENTS.md#generated-files).

`src/health/health.generated.ts` is a copy of [`packages/health`](../../packages/health). Change it
there, not here.

## Building and shipping

```bash
pnpm --filter server build    # compiles to dist/
pnpm --filter server start
```

Build the image from the repository root, with BuildKit:

```bash
docker build -f apps/server/Dockerfile -t server .
```

The image also carries the `orchardctl` builds for linux/amd64 and linux/arm64. Its entrypoint runs
`prisma migrate deploy` before it starts the server, so migrations apply on boot. `Dockerfile.mcp`
builds the standalone MCP server image.

release-please versions this package as the `server` component, so use the `server` commit scope. A
server release publishes `ghcr.io/hackclub/orchard/server` and `ghcr.io/hackclub/orchard/mcp` at the
same version.

## More

- [Architecture](https://docs.orchard.hackclub.com/operate/architecture/)
- [Configuration](https://docs.orchard.hackclub.com/operate/configuration/) and the
  [environment variable reference](https://docs.orchard.hackclub.com/reference/configuration/)
- [Host commands](https://docs.orchard.hackclub.com/operate/host-commands/)
- [Connect an MCP client](https://docs.orchard.hackclub.com/mcp/)
