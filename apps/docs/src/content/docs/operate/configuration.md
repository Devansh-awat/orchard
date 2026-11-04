---
title: Configuration
description: Where Orchard instance settings are stored, which value takes precedence, and how to change them on an installer host or a Helm install.
sidebar:
  order: 2
---

Orchard reads instance settings from environment variables, chart values and the database. An environment variable always takes precedence over a value stored in the database.

## Environment variables

The server reads environment variables at boot. These cover the database URL, registry, app domain, cluster access, object storage and email. For the full list, refer to the [configuration reference](/reference/configuration/).

To change a variable on an installer host, use [`orchardctl env`](/operate/host-commands/#env):

```bash
sudo orchardctl env set SMTP_HOST smtp.example.com --apply
```

On a Helm install, set the variable in `server.env` in your values file.

## Chart values

Chart values control what the chart deploys, such as metrics, logs and the MCP server.

On an installer host, the values file is `/etc/orchard/values.yaml`. To change a value, use [`orchardctl config`](/operate/host-commands/#config):

```bash
sudo orchardctl config set logs.retention 30d --apply
```

On a Helm install, change your values file and run `helm upgrade`.

Re-running the installer keeps your secrets, custom environment variables and volume sizes.

Set cluster-specific values, such as storage class, ingress class and registry, in the values file. These values differ for each cluster.

## Settings stored in the database

To change settings without a restart, go to **Instance admin** > **Configuration**. This page has the following sections:

- **Object storage**
- **Email**
- **Custom domains**
- **Wildcard certificate**
- **Public exposure**
- **GitLab sign-in** and **Bitbucket sign-in**
- **Bot protection**
- **Image scanning**
- **Model Context Protocol**
- **Databases**
- **Anonymous usage reports**

Grafts can add sections to this page. A saved setting reaches every server replica within 30 seconds.

When an environment variable sets a field, the field is read-only and shows `Set by the environment`. Secret fields show `Unchanged` when a value is stored. Leave them blank to keep the value.

`SIGNUP_MODE` is not on this page. To change it, set the `signupMode` chart value to `open`, `invite_only` or `closed`.

## Secrets

Store secrets in Kubernetes Secrets. Do not commit them to a values file in a repository. The installer generates the secrets it needs and writes them to `/etc/orchard/values.yaml`, which only root can read.

## Base domain

`BASE_DOMAIN` is the parent domain for organization vanity addresses and status pages, such as `acme.example.com`. It is independent of the dashboard host and the app domain. Each needs its own DNS records.

When `BASE_DOMAIN` is set, Orchard creates an Ingress and a certificate for each vanity address and status page. The following settings apply to these hosts:

| Setting                 | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `PLATFORM_NAMESPACE`    | The namespace for the Ingress. The chart sets this to the release namespace.                          |
| `PLATFORM_SERVICE_NAME` | The Service that the Ingress points at. The chart sets this to `frontend`.                            |
| `PLATFORM_SERVICE_PORT` | The Service port. The chart sets this to the frontend port.                                           |
| `CERT_CLUSTER_ISSUER`   | The ClusterIssuer for the certificate. Set this with `tenant.certClusterIssuer`. The default is `letsencrypt-prod`. |

The chart does not set these values if you use `server.envFrom`. In that case, add them to your Secret. Without them, the server uses `default/leaf-frontend:3000`.

A vanity address sends visitors to the organization's SSO sign-in page. If the organization has no working SSO connection, visitors go to the normal login page. The dashboard host keeps working if it is a subdomain of `BASE_DOMAIN`.

Changing `BASE_DOMAIN` does not move existing hosts. Each host keeps its Ingress and certificate on the old domain, while the API reports the new one. To move a host:

1. Point DNS for the new domain at the cluster.
2. Clear the subdomain in the organization's settings.
3. Set the subdomain again.

## Database memory

`DATABASE_DEFAULT_MEMORY_MB` sets the memory request for a database that has no size of its own. The default is `1024` and the minimum is `256`. The installer lowers the value on a machine with about 8 GB of memory or less.

## The What's new sheet

The dashboard shows each person the latest release notes once. The server reads the notes from a folder that holds `latest.json` and one Markdown file for each release.

| Setting                | Default                                |
| ---------------------- | -------------------------------------- |
| `UPDATES_URL`          | `https://assets.orchard.my/updates/ui` |
| `updates.url` in chart | Empty, which keeps the server default. |

A value in `server.env` takes precedence over `updates.url`.

To hide the sheet, run the following command:

```bash
sudo orchardctl config set updates.url off --apply
```

To publish your own notes, point the setting at your own folder. `latest.json` needs a `version`, such as `2.70.0`. It can also have `file`, `url` and `publishedAt`. The default `file` is `<version>.md`. A note shows only when its version is at or below the running version of the dashboard.

## Related resources

- [Finish instance setup](/operate/finishing-setup/)
- [Host commands](/operate/host-commands/)
- [Configuration reference](/reference/configuration/)
