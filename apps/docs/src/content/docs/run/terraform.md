---
title: Terraform and OpenTofu
description: Manage projects, apps, databases, domains and jobs from HCL with the Orchard provider.
sidebar:
  order: 9
---

The `hackclub/orchard` provider is one binary that serves both Terraform and OpenTofu.
It talks to your instance with the same API client the `orchard` CLI uses, so anything
the CLI can reach, a plan can too.

## Setting it up

```hcl
terraform {
  required_providers {
    orchard = {
      source = "hackclub/orchard"
    }
  }
}

provider "orchard" {}
```

The provider needs an instance URL and a token. It looks, in order, at the `api_url`
and `token` attributes on the provider block, then `ORCHARD_API_URL` and
`ORCHARD_API_TOKEN`, then the login saved by `orchard auth login`. In CI, set the two
environment variables with an [API token](/account/tokens/).

Until the provider is on a registry, point your client at a local build:

```sh
cd apps/cli && go build -o terraform-provider-orchard ./tofu-provider
```

```hcl
# ~/.terraformrc or ~/.tofurc
provider_installation {
  dev_overrides {
    "hackclub/orchard" = "/absolute/path/to/apps/cli"
  }
  direct {}
}
```

With a dev override in place there is no `init` step. `plan`, `apply` and `destroy`
work as usual.

## A project end to end

```hcl
resource "orchard_project" "midnight" {
  organization_id = var.organization_id
  name            = "Midnight"
}

resource "orchard_database" "db" {
  project_id = orchard_project.midnight.id
  name       = "midnight"
}

resource "orchard_deployment" "web" {
  project_id = orchard_project.midnight.id
  name       = "web"
  image      = "ghcr.io/hackclub/midnight-web:1.4.0"
  port       = 3000
  replicas   = 2
}

# The value is a live reference to the connected database, resolved when the
# pod starts. It follows the database through a restore or a password
# rotation, and the password never lands in state.
resource "orchard_env_var" "database_url" {
  deployment_id = orchard_deployment.web.id
  key           = "DATABASE_URL"
  value         = "$${{resource.midnight.connection_string}}"
}

resource "orchard_ingress" "www" {
  project_id    = orchard_project.midnight.id
  deployment_id = orchard_deployment.web.id
  host          = "midnight.example.com"
}

resource "orchard_job" "nightly" {
  project_id = orchard_project.midnight.id
  name       = "nightly-report"
  schedule   = "0 3 * * *"

  steps {
    name    = "report"
    image   = "ghcr.io/hackclub/midnight-report:1.0.0"
    command = "node report.js"
  }
}
```

A reference like `${{resource.midnight.connection_string}}` needs the database
connected to the app. Pick it under the app's Variables, or let a
[`score.yaml`](/deploy/score/) do it. The provider does not create the connection
itself yet.

## Resources

| Resource | What it manages | Replaced on change |
| --- | --- | --- |
| `orchard_project` | A project in an organization | `organization_id`, `slug` |
| `orchard_deployment` | An app running a container image. Image and replica changes roll the app in place | `name`, `port`, `start_command`, `environment_id` |
| `orchard_database` | A managed Postgres database. Exposes `host`, `port`, `database_name` and `status`, never the password | everything except `name` |
| `orchard_ingress` | A custom domain routed to an app | `deployment_id` |
| `orchard_env_var` | One variable on an app, leaving the rest alone. A `secret` value is write-only | `deployment_id`, `key` |
| `orchard_job` | A scheduled or on-demand job made of image steps | `project_id` |

Apps built from a repository are created from the dashboard or with
`orchard deploy create --github`; the provider can read them and set their variables,
but creates image-based apps only.

## Importing

Every resource supports `import`. Ids are the Orchard ids you see in URLs, with two
composites:

```sh
tofu import orchard_env_var.database_url <deployment id>:DATABASE_URL
tofu import orchard_ingress.www <project id>:<ingress id>
```

## What was verified

The provider round-trips against a live instance: `plan`, `apply`, a second `plan`
reporting no changes, and `destroy` all behave the same under Terraform 1.16 and
OpenTofu 1.12, and the API agrees at every step. Acceptance tests that need a
cluster are not part of CI; the schemas are validated the way `init` validates them.
