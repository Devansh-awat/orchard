---
title: Outbound connections
description: Every host that the Orchard installer, the host commands, and a running instance contact on their own, and how to turn each one off.
sidebar:
  order: 10
---

This page lists the hosts that Orchard contacts on its own. If you restrict outbound traffic, use it as your allowlist.

It does not list connections to services you configure yourself, such as S3 storage, SMTP, notification webhooks, identity providers, and Git providers. Builds also download whatever your Dockerfile or package manager asks for.

## The installer

| Host                                                                  | Used for                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `assets.orchard.my`                                                   | The install script.                                                                |
| `api.ipify.org`, `ipv4.icanhazip.com`                                 | Finding the machine's public IPv4 address. The second is tried if the first fails. |
| `api6.ipify.org`                                                      | Finding the machine's public IPv6 address.                                         |
| `1.1.1.1`, `8.8.8.8`, `2606:4700:4700::1111`, over DNS                | Checking your DNS records. Set `ORCHARD_DNS_RESOLVERS` to use other resolvers.     |
| `cloudflare-dns.com`, `dns.google`, over HTTPS                        | Checking your DNS records, when `dig` is missing or those resolvers do not answer. |
| `get.k3s.io`, `update.k3s.io`, `github.com`                           | The k3s install script, its release channels, and its binary.                      |
| `raw.githubusercontent.com`, `get.helm.sh`                            | The Helm install script and binary.                                                |
| `github.com`                                                          | `yq`, and the Gateway API CRDs.                                                    |
| `traefik.github.io`, `cloudnative-pg.github.io`, `charts.jetstack.io` | The Traefik, CloudNativePG, and cert-manager charts.                               |
| `ghcr.io`                                                             | The Orchard chart and images, and the CloudNativePG images.                        |
| Docker Hub, `quay.io`, `registry.k8s.io`                              | Other images that k3s, the operators, and the chart run.                           |
| `acme-v02.api.letsencrypt.org`                                        | Certificates, in `public` mode.                                                    |
| Cloudflare's network                                                  | The tunnel connection, in `tunnel` mode.                                           |

## Host commands

| Host                                                                  | Used by                                           | To turn it off                                            |
| --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `update.k3s.io`, `github.com`                                         | `orchardctl k3s` and `orchardctl update`          | Set `ORCHARD_K3S_UPDATES=off` in `/etc/orchard/env`.      |
| `traefik.github.io`, `cloudnative-pg.github.io`, `charts.jetstack.io` | `orchardctl update`                               | Set `ORCHARD_ADDON_UPDATES=off` in `/etc/orchard/env`.    |
| `ghcr.io`, Docker Hub, `quay.io`, `registry.k8s.io`                   | `orchardctl update` and `orchardctl images`       | Set `ORCHARD_ADDON_UPDATES=off` in `/etc/orchard/env`.    |
| `api.github.com`                                                      | `orchardctl images`, for the latest Railpack      | Do not run the command.                                   |
| `assets.orchard.my/registry`                                          | `orchardctl graft`, for the Extension Marketplace | Set `ORCHARD_GRAFT_MARKETPLACE_URL` to your own registry. |

## A running instance

| Host                                              | When                                                                                                                             | To turn it off                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `us.i.posthog.com`                                | Only after a superadmin opts in to [usage reports](/operate/telemetry/).                                                         | Leave reports off, or set `ORCHARD_TELEMETRY=false`.                                      |
| `assets.orchard.my/registry`                      | Every 6 hours, for templates.                                                                                                    | Set `TEMPLATE_REGISTRY_URL` to an empty value, or to your own registry.                   |
| `assets.orchard.my/updates/ui`                    | For the What's new feed.                                                                                                         | Set `UPDATES_URL=off`, or run `sudo orchardctl config set updates.url off --apply`.       |
| `assets.orchard.my`                               | When the dashboard loads a template or graft icon through its image proxy.                                                       | Set `ASSET_PROXY_HOSTS` on the frontend to your own host.                                 |
| `raw.githubusercontent.com`                       | To read the CloudNativePG image catalog, which lists the Postgres versions on offer.                                             | Set `POSTGRES_IMAGE_CATALOG_URL` to your own copy.                                        |
| `www.postgresql.org`                              | Every hour, to read Postgres versions and security advisories.                                                                   | No setting.                                                                               |
| `ipwho.is`                                        | When someone signs in from a public address. Orchard sends that address, and shows the approximate location in the session list. | No setting.                                                                               |
| `seccdn.libravatar.org`, `gravatar.com`           | To import a profile picture, at most once per user every 30 days. Orchard sends a hash of the email address.                     | Set `EMAIL_AVATAR_PROVIDERS=none`.                                                        |
| `data.iana.org`, and the RDAP server for a domain | To check when a domain was registered, for organization domains and email sign-in codes.                                         | No setting.                                                                               |
| `acme-v02.api.letsencrypt.org`                    | For certificates, through cert-manager.                                                                                          | Use your own issuer.                                                                      |
| `update.traefik.io`                               | Traefik's own check for a new version.                                                                                           | Set `global.checkNewVersion` to `false` in the Traefik chart values.                      |
| `github.com`, `api.github.com`                    | For the GitHub App, and to clone repositories.                                                                                   | Do not connect GitHub. Public repositories are cloned when someone deploys one.           |
| `github.com`                                      | When a build uses Railpack, to download it.                                                                                      | Deploy with a Dockerfile or an image.                                                     |
| `mirror.gcr.io`, `ghcr.io`                        | For the image scanner's vulnerability database.                                                                                  | Set `trivy.dbRepository` and `trivy.javaDbRepository`, or set `trivy.enabled` to `false`. |
| `api.cloudflare.com`                              | When you manage Cloudflare Tunnel routes from **Instance admin** > **Networking**.                                               | Do not connect Cloudflare.                                                                |
| `challenges.cloudflare.com`                       | When [bot protection](/operate/bot-protection/) is on.                                                                           | Turn off bot protection.                                                                  |
| `depot.dev`                                       | When a build uses Orchard's super builds.                                                                                        | Do not turn on super builds.                                                              |

If you set `POSTHOG_API_KEY`, the server also sends analytics to `POSTHOG_HOST`, which defaults to `us.i.posthog.com`. It is off when the key is unset.

Installed [grafts](/grafts/overview/) can make connections of their own.

## Related resources

- [Manage anonymous usage reports](/operate/telemetry/)
- [Install](/start/install/)
- [Environment variables](/reference/configuration/)
- [Host commands](/operate/host-commands/)
