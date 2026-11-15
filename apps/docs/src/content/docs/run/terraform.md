---
title: Manage Orchard with Terraform and OpenTofu
description: Manage Orchard projects, apps, databases, domains, variables, and jobs from HCL with the hackclub/orchard provider for Terraform and OpenTofu.
sidebar:
  order: 9
---

The `hackclub/orchard` provider lets you describe Orchard projects, apps, databases, and jobs in HCL and keep them in version control, instead of creating them by hand in the dashboard. One binary serves both Terraform and OpenTofu, and it uses the same API client as the `orchard` CLI.

## Prerequisites

- An Orchard instance.
- An [API token](/account/tokens/) or a saved sign-in from `orchard auth login`.
- Terraform or OpenTofu.
- Go, to build the provider locally.

## Install the provider

The provider is not yet on a public registry. To use it, build it and point your client at the build.

1. Build the provider:

   ```sh
   cd apps/cli && go build -o terraform-provider-orchard ./tofu-provider
   ```

2. Add a development override to `~/.terraformrc` or `~/.tofurc`:

   ```hcl
   provider_installation {
     dev_overrides {
       "hackclub/orchard" = "/absolute/path/to/apps/cli"
     }
     direct {}
   }
   ```

With a development override, you do not run `init`. `plan`, `apply`, and `destroy` work as usual.

## Configure the provider

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

The provider reads the instance URL and token from these places, in order:

1. The `api_url` and `token` attributes on the provider block.
2. The `ORCHARD_API_URL` and `ORCHARD_API_TOKEN` environment variables.
3. The token saved by `orchard auth login`.

In CI, set the two environment variables.

## Example

The following configuration creates a project with a database, an app, a variable, a domain, and a scheduled job.

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
  image      = "ghcr.io/example/midnight-web:1.4.0"
  port       = 3000
  replicas   = 2
}

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
    image   = "ghcr.io/example/midnight-report:1.0.0"
    command = "node report.js"
  }
}
```

The `DATABASE_URL` value is a reference that Orchard resolves when the pod starts. The password does not appear in state.

:::note
A reference needs the database to be connected to the app, and the provider does not create that connection. To connect the database, use **Use a resource** on the app's **Variables** tab, or a [`score.yaml`](/deploy/score/) file.
:::

## Resources

| Resource             | Manages                                                                                                                               | Replaced when these change                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `orchard_project`    | A project in an organization                                                                                                          | `organization_id`, `slug`                                       |
| `orchard_deployment` | An app that runs a [container image](/deploy/image/). Image and replica changes roll the app in place.                                | `project_id`, `environment_id`, `name`, `port`, `start_command` |
| `orchard_database`   | A [managed Postgres database](/data/databases/). Exposes `host`, `port`, `database_name`, and `status`. Does not expose the password. | Every attribute                                                 |
| `orchard_ingress`    | A [custom domain](/deploy/domains/#add-a-custom-domain) routed to an app                                                              | `project_id`, `deployment_id`                                   |
| `orchard_env_var`    | One [variable](/run/environments/) on an app. Other variables stay as they are. A `secret` value is write-only.                       | `deployment_id`, `key`                                          |
| `orchard_job`        | A scheduled or on-demand [job](/run/jobs/) made of image steps                                                                        | `project_id`                                                    |

The provider creates only image-based apps. To create an app from a repository, use the dashboard or `orchard deploy create --github`. The provider can then read that app and set its variables.

## Import existing resources

Each resource supports `import`. IDs are the Orchard IDs in URLs. Two resources use composite IDs:

```sh
tofu import orchard_env_var.database_url <deployment id>:DATABASE_URL
tofu import orchard_ingress.www <project id>:<ingress id>
```

## Related resources

- [Manage API tokens](/account/tokens/) - Create a token for the provider to use in CI.
- [Connect an app to a database or app](/deploy/connect-resources/) - Create the connection that a `${{resource...}}` reference needs.
