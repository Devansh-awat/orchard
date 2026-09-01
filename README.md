<div align="center">

<img src=".github/assets/banner.png" alt="Orchard" width="100%">

<br>

# A Hack Club project created by [Leafd](https://github.com/LeafdTK)

### Push a repo. Get a running app. On the cluster you already own.

<br>

[![Release](https://github.com/hackclub/orchard/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/hackclub/orchard/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-c93a4f?labelColor=1a0f11)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.orchard.my-c93a4f?labelColor=1a0f11)](https://docs.orchard.my)
[![Helm chart](https://img.shields.io/badge/helm-ghcr.io%2Fhackclub%2Forchard-c93a4f?labelColor=1a0f11)](https://github.com/hackclub/orchard/pkgs/container/orchard%2Fcharts%2Forchard)

**[Docs](https://docs.orchard.my)** ·
[Install](https://docs.orchard.my/start/install/) ·
[First deploy](https://docs.orchard.my/start/first-deploy/) ·
[CLI](https://docs.orchard.my/reference/cli/) ·
[API](https://docs.orchard.my/api/) ·
[MCP](https://docs.orchard.my/mcp/)

<br>

<img src="apps/landing/static/screenshots/project.png" alt="An Orchard project page showing running apps and their databases" width="880">

</div>

<br>

## What is this

Orchard installs into a Kubernetes cluster **you** own and turns it into
something that feels like a PaaS. Point it at a GitHub repo and it builds the
image, runs it, routes traffic to it, hands it a Postgres database, and shows
you the logs when it breaks.

Similar to Coolify or Dokploy, except it targets Kubernetes. Replicas, rolling
updates, health checks, quotas and node scheduling all come from the platform
underneath, instead of being rebuilt on top of Docker.

Nothing phones home. The scheduler is your cluster, the registry is yours, and
the data stays on your hardware.

## What it does

| | |
|---|---|
| **Deploys** | GitHub repos or container images, built on your cluster with logs streaming as they happen |
| **Routing** | An HTTPS URL per app, custom domains with certificates that renew themselves, and an auth wall if you want one |
| **Data** | Managed Postgres with backups, extensions, read replicas and a query console |
| **Jobs** | Cron schedules and multi-step pipelines, with per-step output and exit codes |
| **Visibility** | Live logs by pod and time range, CPU and memory over time, plus the logs of containers that already died |
| **Teams** | Organizations, projects, roles, SSO, SCIM provisioning, audit logs and quotas |
| **Interfaces** | A web dashboard, a Go CLI, and an MCP server so your agent can drive it |

## How to install

Got a bare Linux box with nothing on it?

```bash
curl -fsSL https://assets.orchard.my/install.sh | sudo bash
```

It brings its own k3s, Traefik, CloudNativePG, cert-manager and registry. One
command and you are done.

Already running Kubernetes? Use the Helm chart instead, because the installer
would try to install k3s underneath you:

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard --create-namespace -f my-values.yaml
```

The full walkthrough with prerequisites and DNS lives at
**[docs.orchard.my/start/install](https://docs.orchard.my/start/install/)**

> [!IMPORTANT]
> Deployments are network isolated from each other and from the platform by
> default, but they **share the host kernel** unless you install gVisor or Kata
> and switch them on. Running untrusted code is not safe out of the box. Please
> read [Security and isolation](https://docs.orchard.my/operate/security/)
> before letting strangers deploy things.

> [!TIP]
> A fresh install is not a production instance. Secrets, signup mode, TLS
> cookies, control-plane backups and isolation all need a decision from you
> first. [Going to production](https://docs.orchard.my/operate/production/)
> walks through the whole list.

## How to write commits (read this if you are contributing)

Release-please handles versioning here, and it wants commits written a specific
way ([Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/),
not as scary as it sounds).

**`feat:`** you added a thing. Bumps the minor version (1.2.3 to 1.3.0)

**`fix:`** you fixed a thing. Bumps the patch version (1.2.3 to 1.2.4)

**`chore:`** boring maintenance. Dependencies, typos, readmes

Only those three, all lowercase, subject line only. No body, the diff says the
rest.

```
feat: add cool thingy
fix: stop thingy crashing on Tuesdays
chore: update readme
```

Please write them in infinitive form ("add thing", not "added thing").

## Where the code lives

<details>
<summary><b>Monorepo layout</b></summary>

<br>

```
apps/                  deployable units (one container image each)
  frontend             SvelteKit web app
  server               NestJS API + Prisma
  gateway              Go edge gateway
  r2-proxy             Go R2 storage proxy
  cli                  Go CLI (`orchard`)
  landing              marketing site
  docs                 documentation site (Astro Starlight)
packages/              shared, importable code (not deployed)
infra/                 charts/ (Helm) · k8s/ · datadog/
install/               one-command installer
docs/                  design + architecture notes
```

`apps/*` are things you **deploy**, they have a Dockerfile and get released.
`packages/*` are things you **import**, shared code, never deployed.

</details>

<details>
<summary><b>Running it locally</b></summary>

<br>

You will want Node 22+, pnpm 10, Go 1.22+ (1.26 for the CLI) and Docker.

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d    # Postgres 16 + Redis

cp .env.example apps/server/.env                  # defaults boot as-is
cp apps/frontend/.env.example apps/frontend/.env

pnpm --filter server prisma:generate
pnpm --filter server prisma:migrate               # apply migrations
pnpm --filter server prisma:seed                  # demo data

pnpm dev                                          # frontend + server + gateway
```

Then open <http://localhost:4000>. The gateway proxies `/apiv1/*` to the API on
3001 and everything else to Vite on 3000, so always use `:4000` or logins break
in confusing ways.

The seed gives you `admin@orchard.dev` in the `orchard-demo` org. Sign in with
an email OTP; codes print to the server console when SMTP is not configured.

You do **not** need a Kubernetes cluster for UI or API work. The server boots
without one, and deploy and build features return 503 until you point
`KUBECONFIG_PATH` at something.

Per service:

```bash
pnpm --filter frontend dev
pnpm --filter server dev
pnpm --filter landing dev    # marketing site  :5173
pnpm --filter docs dev       # documentation   :5174
cd apps/cli && go run .
```

Tests:

```bash
pnpm --filter server test:auth-coverage   # route/auth snapshot (no DB needed)
pnpm --filter server test:rbac            # e2e, needs a running server + DB
cd apps/cli && go test ./...
```

</details>

<details>
<summary><b>Docs that cannot go stale</b></summary>

<br>

Every reference page is generated from the thing it documents: the OpenAPI
contract, the CLI's own command tree, the MCP tool registry, and
`.env.example`.

```bash
pnpm --filter docs generate         # API, CLI, MCP tools, config vars
pnpm --filter docs check:generated  # fails if the output is stale
```

CI runs that check, so adding a route without regenerating fails the build
instead of quietly shipping docs that lie to people.

</details>

<details>
<summary><b>Releases and CI</b></summary>

<br>

- **PRs** run checks in GitHub Actions, skipping whatever did not change
- **`main`** runs release-please. Each service is versioned on its own
  (`<service>/vX.Y.Z`), and only the services that got bumped build and publish
  their image to GHCR

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the service-split roadmap
and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the PR workflow.

</details>

## Help, I have questions

Confused? Found a bug? Want to say hi?

Open an issue, or poke me on Slack at **@lfd**

## License

[AGPL-3.0](LICENSE). The web app, the API, the gateway, the CLI, all of it. Not
an open core with the good parts held back.

<br>

<div align="center">

*Made with <3 by a leaf*

</div>
