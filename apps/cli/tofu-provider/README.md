# terraform-provider-orchard

One binary for Terraform and OpenTofu. It talks to an Orchard instance with the same
API client the `orchard` CLI uses, so anything the CLI can reach, this can too.

```hcl
terraform {
  required_providers {
    orchard = {
      source = "hackclub/orchard"
    }
  }
}

provider "orchard" {
  # api_url and token fall back to ORCHARD_API_URL / ORCHARD_API_TOKEN,
  # then to the login saved by `orchard auth login`.
}

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

# Read the database live instead of copying a password into state. The value
# resolves when the pod starts and follows the database through a restore or
# a password rotation. Connect the database to the app in the dashboard, or
# let Orchard do it when the app starts from a score.yaml.
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

## Resources

| Resource | Backed by |
| --- | --- |
| `orchard_project` | `POST /projects`, `PATCH /projects/:id` |
| `orchard_deployment` | `POST /projects/:id/deployments`, image and scale endpoints |
| `orchard_database` | `POST /projects/:id/databases` |
| `orchard_ingress` | `POST /projects/:id/ingresses` |
| `orchard_env_var` | `PUT /deployments/:id/env`, leaving other variables alone |
| `orchard_job` | `POST /projects/:id/jobs`, `PUT /jobs/:id/steps` |

Secrets never enter state: a database resource exposes host, port and name but not
the password, and a secret env var is write-only.

## Building

```sh
cd apps/cli
go build -o terraform-provider-orchard ./tofu-provider
```

For local use, point a dev override at the binary:

```hcl
# ~/.terraformrc or ~/.tofurc
provider_installation {
  dev_overrides {
    "hackclub/orchard" = "/absolute/path/to/apps/cli"
  }
  direct {}
}
```

## Releasing

`.goreleaser.yml` in this directory builds the platform matrix, signs the checksums
with GPG and publishes a GitHub release. Both the Terraform Registry and
`registry.opentofu.org` pull from that release feed; each needs a one-time submission
with the signing key.
