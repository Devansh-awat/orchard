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

**Please follow the [install guide](https://docs.orchard.my/start/install/).** It covers every step in
detail.

If you just want the command, you need a Linux server with at least 4 GB of RAM and 20 GB of free disk:

```bash
sudo bash -c "$(curl -fsSL https://assets.orchard.my/install.sh)"
```

![Installing Orchard on a Linux server](.github/assets/install.gif)

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

## Works with your agent

Connect Claude, Cursor or any MCP client, and it can deploy apps, add databases, read logs and roll back
a bad deploy. [Set up MCP](https://docs.orchard.my/mcp/).

It can install Orchard for you too:

```
Install Orchard on my server following https://docs.orchard.my/start/install.md. Ask me before anything that is not reversible.
```

## Features

- **Deploy from GitHub.** Connect a repo, and every push builds and deploys your app.
- **HTTPS and domains.** Every app gets an HTTPS URL, and you can add your own domains.
- **Managed Postgres.** Add a database with backups and point-in-time restore.
- **Logs and metrics.** Search logs and see requests, errors and resource use for each app.
- **Rollbacks.** Go back to an earlier version when a deploy goes wrong.
- **Templates.** Deploy any of 90+ [ready-made apps](https://orchard.my/templates).
- **Teams.** Organizations, roles, SSO and audit logs.

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
