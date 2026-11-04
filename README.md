<img src=".github/assets/banner.png" alt="Orchard" width="100%">

# Orchard

### A project made by [Leafd](https://github.com/LeafdTK)

[![Made by Leafd](https://img.shields.io/badge/made%20by-Leafd-c93a4f?style=for-the-badge&logo=github&logoColor=white&labelColor=1a0f11)](https://github.com/LeafdTK)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-c93a4f?style=for-the-badge&logo=kubernetes&logoColor=white)](https://docs.orchard.my/start/what-is-orchard/)
[![Self-hosted](https://img.shields.io/badge/self--hosted-1a0f11?style=for-the-badge)](https://docs.orchard.my/start/install/)
[![License](https://img.shields.io/badge/license-AGPL--3.0-c93a4f?style=for-the-badge&labelColor=1a0f11)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.orchard.my-1a0f11?style=for-the-badge)](https://docs.orchard.my)

Turn any Linux box into a private hosting platform.

Install Orchard, connect a GitHub repo, and your app is live on your own server.

## Installation

```bash
sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)"
```

It asks for a domain and an email, then brings its own k3s, Traefik, CloudNativePG, cert-manager,
registry, metrics, log search and image scanner. You need amd64 or arm64, at least 4 GB of RAM (8 GB is
comfortable) and 20 GB of free disk (60 GB once you're building things).

| Mode     | Use it when                                 | HTTPS                                 |
| -------- | ------------------------------------------- | ------------------------------------- |
| `public` | The box has a public IP and free 80 and 443 | Let's Encrypt                         |
| `tunnel` | It's behind NAT, or those ports are taken   | Cloudflare, through Cloudflare Tunnel |
| `lan`    | It's only for your LAN or Tailscale         | Self-signed                           |

> [!IMPORTANT]
> Deployments are network isolated from each other and from the platform by default, but they **share
> the host kernel** unless you install gVisor or Kata and switch them on. Running untrusted code is not
> safe out of the box. Read [Security and isolation](https://docs.orchard.my/operate/security/) before
> letting strangers deploy things.

> [!TIP]
> A fresh install is not a production instance. Secrets, signup mode, TLS cookies, control-plane backups
> and isolation all need a decision from you.
> [Going to production](https://docs.orchard.my/operate/production/) walks through the list.

### Already running Kubernetes?

The installer would put k3s underneath you, so use the Helm chart instead:

```bash
helm install orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard --create-namespace -f my-values.yaml
```

The [install guide](https://docs.orchard.my/start/install/) has a minimal values file, DNS and every
flag.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screenshots/project-dark.png">
  <img src=".github/assets/screenshots/project-light.png" alt="An Orchard project with its apps, databases and recent builds" width="100%">
</picture>

## Say what you want. Your agent does the rest.

Orchard ships an [MCP server](https://docs.orchard.my/mcp/), so Claude, Cursor or any MCP client can run
your whole platform. About 160 tools cover deploying apps, adding databases, reading logs, working out
why a rollout failed and rolling it back. A compact mode reaches the full API of about 450 operations
without filling the model's context.

> Deploy this repo with a Postgres database, then tell me why the last build failed.

Your agent acts as you, with your permissions and nothing more. Sign-in is OAuth with an explicit
approval step, tokens are scoped to read, deploy or exec, and **Settings → MCP** gives you ready-made
config for Claude, Claude Code, VS Code and Cursor.

It can even do the install. Paste this into an agent on your server:

```
Install Orchard on my server following https://docs.orchard.my/start/install.md. Ask me before anything that is not reversible.
```

## Features

- **Deploy from GitHub.** Push to your repo and it rebuilds on its own
- **Roll back.** The last deploy was a mistake. Now it never happened
- **Fork a database.** Try the scary migration on a real copy of your data first
- **Find out why it broke.** Logs, metrics and request stats, even for containers that already died
- **Open a shell.** For when you really do have to look inside

And the rest:

- HTTPS on every app, custom domains and an auth wall if you want one
- Managed Postgres with backups, point-in-time restore, read replicas and a query console
- Cron and multi-step jobs, Compose stacks, and 90+ [templates](https://orchard.my/templates)
- Log search, per-route request stats, image scanning and alerts
- Organizations, roles, SSO, SCIM, audit logs and quotas
- A [CLI](https://docs.orchard.my/reference/cli/), an [API](https://docs.orchard.my/api/) and an OpenTofu provider

Orchard runs on Kubernetes, so replicas, rolling updates, health checks, quotas and node scheduling come from the platform underneath. Everything it creates is a normal Kubernetes resource you can still `kubectl get`.

---

## Table of contents

- [Installation](#installation)
  - [Already running Kubernetes?](#already-running-kubernetes)
- [Say what you want. Your agent does the rest.](#say-what-you-want-your-agent-does-the-rest)
- [Features](#features)
- [Contributing](#contributing)
- [Help](#help)
- [License](#license)

---

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers running it locally and
how commits drive releases, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit
together. Report security issues privately: see [SECURITY.md](SECURITY.md).

## Help

Open an [issue](https://github.com/hackclub/orchard/issues), or find **@lfd** on the
[Hack Club Slack](https://slack.hackclub.com).

## License

[AGPL-3.0](LICENSE).

---

Made by [Leafd](https://github.com/LeafdTK).
