---
title: Known limitations
description: Review what Orchard does not support, what works only under a condition, and what Orchard has not tested, with the workaround for each limitation.
sidebar:
  order: 6
---

This page lists what Orchard does not support, what works only when you configure it, and what Orchard has not tested. Read it before you install, and again before you let other people deploy to your instance. Each item links to the page with the details and, where one exists, the workaround.

## Installation and scale

- **One node per installer host.** The one-command installer builds a single-node k3s cluster, and adding nodes to it is not supported yet. For more than one machine, use the Helm chart. Refer to [Add and remove nodes](/operate/nodes/#on-an-installer-host).
- **Limited testing of the chart's quick install.** The documented Helm steps were run end to end on one k3s node with Traefik only. Refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).
- **Fewer features on small servers.** Under 3.5 GiB of RAM, the installer turns off the MCP endpoint and image scanning. Refer to [The smallest profile](/operate/small-servers/#the-smallest-profile).
- **Upgrades go forward only.** Schema migrations run when the server starts, so after `helm rollback` the old version may not run against the migrated schema. Refer to [Database migrations](/operate/upgrades/#database-migrations).
- **More than one server replica needs Redis.** Without Redis, each replica delivers only its own dashboard events. Refer to [Run more than one server replica](/operate/scale-control-plane/#run-more-than-one-server-replica).

## Isolation and security

- **Shared host kernel by default.** Apps, builds, and Postgres pods share the node's kernel until you install gVisor or Kata yourself and turn them on. Refer to [Kernel isolation](/operate/security/#kernel-isolation).
- **Not safe for untrusted code out of the box.** Set up sandboxes, quotas, node pools, and closed signups before people you do not trust deploy code. Refer to [Requirements for untrusted code](/operate/security/#requirements-for-untrusted-code).
- **Isolation depends on the CNI.** Tenant isolation holds only on a Container Network Interface (CNI) plugin that enforces NetworkPolicy, and plain Flannel does not. Refer to [Enforce network policies on Flannel](/operate/security/#enforce-network-policies-on-flannel).
- **The server controls the cluster.** A compromise of the server is a compromise of the cluster. Refer to [What Orchard does not guarantee](/operate/security/#what-orchard-does-not-guarantee).
- **Shared keys across tenants.** One key encrypts secrets for every organization, and all builds share one registry login. Refer to [What Orchard does not guarantee](/operate/security/#what-orchard-does-not-guarantee).
- **No row-level security.** Authorization runs in the API services, so the database does not catch a missing check in a route. Refer to [What Orchard does not guarantee](/operate/security/#what-orchard-does-not-guarantee).
- **Edit access includes secrets.** Anyone with edit access to a project can open a shell in its app pods and read their environment variables. Refer to [Shell access and databases](/operate/security/#shell-access-and-databases).
- **Audit logs do not cover `kubectl`.** Actions taken directly on the cluster do not appear in the audit log. Refer to [Audit logs](/teams/audit-logs/#limitations).

## Networking

- **Node blocking is approximate without Cilium.** With any other CNI, address exceptions computed from the node list keep tenant pods away from host-network services. Refer to [What differs without Cilium](/operate/compatibility/#what-differs-without-cilium).
- **Outbound IPv4 only.** The tenant egress policy allows the public IPv4 internet, so apps cannot open outbound IPv6 connections.
- **No raw ports in tunnel mode.** Cloudflare Tunnel carries HTTP only, so a `tunnel` install has no public TCP and UDP ports or public database access. Refer to [Publish a TCP or UDP port](/deploy/networking/#publish-a-tcp-or-udp-port).
- **Public ports hide the client address.** The app sees a node address as the client address, not the real one. Refer to [Public TCP and UDP ports](/operate/security/#public-tcp-and-udp-ports).
- **Protected domains depend on the server.** A domain with **Password** or **Project members** protection, or **Username and password** protection without Cilium, stops responding while the server is down. Refer to [How operators enable each type](/deploy/protection/#how-operators-enable-each-type).
- **Self-signed certificates in `lan` mode.** A `lan` install gives apps self-signed certificates and serves the dashboard over plain HTTP, so passkeys do not work. Refer to [Certificates](/deploy/domains/#certificates).
- **No Gateway API.** Tenant apps use `Ingress`, not Gateway API (`HTTPRoute`). Refer to [Supported ingress controllers](/operate/compatibility/#supported-ingress-controllers).
- **Port 80 stays open in `public` mode.** Let's Encrypt uses port 80 for every new app hostname and every renewal. Refer to [Choose an ingress mode](/start/install/#choose-an-ingress-mode).
- **The metrics and log stores have no authentication.** Do not expose VictoriaMetrics or VictoriaLogs outside the cluster. Refer to [Control-plane namespaces](/operate/security/#control-plane-namespaces).

## Databases and storage

- **Postgres is the only managed database.** Other databases run as apps from [templates](/run/templates/), without managed backups or point-in-time restore. Refer to [Can I run databases other than Postgres?](/start/faq/#can-i-run-databases-other-than-postgres).
- **Allowlisted Postgres extensions only.** Orchard refuses extensions that are not on its allowlist. Refer to [Allowed extensions](/data/extensions/#allowed-extensions).
- **A volume limits replicas and deploys.** An app with a volume runs one pod on most storage classes and has brief downtime on every deploy. Refer to [Attach storage to an app](/deploy/storage/#limitations).
- **Volumes do not shrink.** A volume can grow on a storage class that allows expansion, but it cannot shrink.
- **`local-path` volumes stay on their node.** A pod whose volume exists on one node does not move when that node fails or drains. Refer to [Remove a node from a Helm cluster](/operate/nodes/#remove-a-node-from-a-helm-cluster).
- **Standbys on one machine do not survive its loss.** On an installer host, standbys protect against a failed Postgres instance, not a lost machine. Refer to [Configure high availability](/data/high-availability/).

## Builds

- **Builds need a registry.** On a Helm install without `DOCKER_REGISTRY_PUSH` and `DOCKER_REGISTRY_PULL`, only prebuilt images deploy. Refer to [Image builds need a container registry](/operate/troubleshooting/#image-builds-need-a-container-registry).
- **Rootless builds need user namespaces.** Default builds fail on nodes that do not allow unprivileged user namespaces. Refer to [Builds without a sandbox runtime](/operate/security/#builds-without-a-sandbox-runtime).
- **One architecture per instance.** Orchard builds images for one platform, `linux/amd64` or `linux/arm64`, set by `builders.platform` (`BUILD_PLATFORM`), and does not build multi-architecture images.
- **Some Dockerfile options are refused.** Orchard refuses `RUN --security=insecure` and `RUN --network=host` in every mode.
- **`orchard up` needs S3 storage.** Deploying a local directory needs S3-compatible storage that build pods can reach. Refer to [Turn on local deploys](/deploy/deploy-from-terminal/#turn-on-local-deploys).
- **Compose stacks come from GitHub only.** Orchard reads the compose file from a GitHub repository and ignores some compose keys. Refer to [How Orchard reads the file](/run/compose/#how-orchard-reads-the-file).

## Backups and recovery

- **Database backups need storage.** Backups, point-in-time restore, checkpoints, and restores need an S3-compatible bucket, which the Helm chart does not set up by default. Refer to [Back up and restore a database](/data/backups/#prerequisites).
- **The store on the server is not disaster recovery.** It sits on the same disk as the databases. Refer to [The store on the server](/data/backups/#the-store-on-the-server).
- **Older hosts need a backup migration before CloudNativePG 1.31.** Hosts that still use CloudNativePG's built-in Barman Cloud backups must move to the Barman Cloud plugin first. Refer to [Move database backups to the Barman Cloud plugin](/operate/upgrades/#move-database-backups-to-the-barman-cloud-plugin).
- **30-day recovery window.** Orchard removes backups and write-ahead log (WAL) older than 30 days. Refer to [Retention](/data/backups/#retention).
- **Control-plane backups are off by default.** Continuous backups of Orchard's own database need setup. Refer to [Back up the control-plane database](/operate/production/#5-back-up-the-control-plane-database).
- **Instance recovery is untested.** Orchard has not tested bringing back a whole instance on a new machine end to end. Refer to [Restore the control plane](/operate/backup-and-restore/#restore-the-control-plane).
- **App volumes and images are not backed up.** Back up volume data from inside the app. Refer to [What to back up](/operate/backup-and-restore/#what-to-back-up).
- **A restore needs the original secrets key.** Without the original `SECRETS_ENCRYPTION_KEY`, Orchard cannot read the stored secrets, even after a successful restore.

## Integrations

- **Bitbucket app passwords do not work.** Link Bitbucket Cloud with an Atlassian API token, an access token, or **Sign in with Bitbucket**. Refer to [Replace a Bitbucket app password](/deploy/git-providers/#replace-a-bitbucket-app-password).
- **Git connections use HTTPS.** A Git connection needs an `https://` base URL. Refer to [Deploy from GitLab, Gitea, and others](/deploy/git-providers/).
- **GitHub auto-deploy needs the GitHub App.** A push builds only when a GitHub App on the instance can see the repository. Refer to [Deploy from GitHub](/deploy/github/).
- **No email without SMTP.** Without SMTP settings, Orchard sends no email, and invitations are links that you copy. Refer to [Set up email](/operate/finishing-setup/#set-up-email).
- **SAML restrictions.** Orchard rejects IdP-initiated sign-in, encrypted assertions, and SHA-1 signatures. Refer to [SAML requirements](/teams/sso/#saml-requirements).
- **The Terraform provider is not on a public registry.** Build the provider and point your client at the build. Refer to [Install the provider](/run/terraform/#install-the-provider).

## Observability

- **Request metrics need Traefik or HAProxy.** With another ingress controller, apps run, but the request, error, and latency charts stay empty. Refer to [Point app metrics at your ingress controller](/operate/finishing-setup/#point-app-metrics-at-your-ingress-controller).
- **Request logs and attack signals need Traefik or HAProxy.** The **Requests** view and the attack card read access logs from those controllers only. Refer to [Access logs](/operate/logs/#access-logs).

## Extensions (grafts)

- **Grafts run with full server privileges.** A graft runs inside Orchard with no sandbox, so install only grafts whose publisher you would give full control of your server. Refer to [Trust](/grafts/install/#trust).
- **Community graft updates are not reviewed by hand.** Later versions of a community graft pass automated checks only. Refer to [Where grafts come from](/grafts/install/#where-grafts-come-from).

## Platform support

- **Installer hosts.** The installer needs Linux with systemd, an amd64 or arm64 CPU, an IPv4 address, root access, and 20 GB of free disk, and CI tests it on Ubuntu only. Refer to [Prerequisites](/start/install/#prerequisites).
- **No IPv6-only servers.** The installer stops on a server with no IPv4 address. Refer to [The installer stops on an IPv6-only server](/operate/troubleshooting/#the-installer-stops-on-an-ipv6-only-server).
- **No installs inside Docker.** k3s cannot nest its overlayfs snapshotter in a Docker container. Use a virtual machine or a physical machine.
- **Kubernetes 1.30 or later for the Helm chart.** The chart installs `ValidatingAdmissionPolicy` objects. Refer to [Kubernetes versions and distributions](/operate/compatibility/#kubernetes-versions-and-distributions).
- **Kubernetes is the source of truth.** Orchard adopts changes made with `kubectl`, except to security objects, which it restores. Refer to [Architecture](/operate/architecture/#reads).

## Related resources

- [Security and isolation](/operate/security/) - Review every isolation guarantee, what you must configure for it, and what Orchard does not guarantee.
- [Go to production](/operate/production/) - Work through the settings to check before other people depend on your instance.
