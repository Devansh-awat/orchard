---
title: Known limitations
description: Review what Orchard does not support, what works only under a condition, and what Orchard has not tested, with the workaround for each limitation.
sidebar:
  order: 6
---

This page lists what Orchard does not support, what works only when you configure it, and what Orchard has not tested. Read it before you install, and again before you let other people deploy to your instance. Each item links to the page with the details and, where one exists, the workaround.

## Installation and scale

- **One node per installer host.** The one-command installer builds a single-node k3s cluster. Adding nodes to an installer host is not supported for now, and support is planned for a later release. That machine is a single point of failure. To run on more than one machine, use the [Helm chart](/start/install/#install-on-an-existing-cluster). Refer to [Add and remove nodes](/operate/nodes/#on-an-installer-host).
- **Limited testing of the chart's quick install.** The documented Helm steps were run end to end on one k3s node with Traefik. Orchard has not tested that path with other ingress controllers, with backups to the `objectStorage` store, with MCP, or with public database exposure. Hack Club runs the chart on a six-node Talos Linux cluster with Cilium. Refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).
- **Fewer features on small servers.** Under 3.5 GiB of RAM, the installer turns off the MCP endpoint and image scanning. You can turn both on again. Refer to [The smallest profile](/operate/small-servers/#the-smallest-profile).
- **Upgrades go forward only.** Schema migrations run when the server starts, and an older server with a newer schema is not supported. After `helm rollback`, the old version may not run against the migrated schema. Refer to [Database migrations](/operate/upgrades/#database-migrations).
- **More than one server replica needs Redis.** Without Redis, each replica delivers only its own dashboard events. The chart runs Redis by default. Refer to [Run more than one server replica](/operate/scale-control-plane/#run-more-than-one-server-replica).

## Isolation and security

- **Shared host kernel by default.** Apps, builds, and Postgres pods run on the node's kernel unless you install gVisor or Kata and turn on `tenantSandbox`, `builderSandbox`, and `databases.runtimeClassName`. The installer installs neither runtime, so a container escape reaches every tenant on the node. Refer to [Kernel isolation](/operate/security/#kernel-isolation).
- **Not safe for untrusted code out of the box.** Before people you do not trust deploy code, set up the sandbox runtimes, quotas, node pools, and closed signups. Without them, a single-machine instance gives those people about the same access as Docker on that machine. Refer to [Requirements for untrusted code](/operate/security/#requirements-for-untrusted-code).
- **Builds without a sandbox share the node kernel.** Without `builderSandbox`, builds run in rootless BuildKit on the node kernel, with seccomp and AppArmor set to `Unconfined`. Refer to [Builds without a sandbox runtime](/operate/security/#builds-without-a-sandbox-runtime).
- **The server controls the cluster.** The server's service account can create pods in any namespace and remove the isolation policies, so a compromise of the server is a compromise of the cluster. Refer to [What Orchard does not guarantee](/operate/tenancy-and-isolation/#what-orchard-does-not-guarantee).
- **Shared keys across tenants.** One key encrypts secrets for every organization, and all builds share one registry login, which stays in a container that does not run tenant code.
- **No row-level security.** Authorization runs in the API services, so the database does not catch a missing check in a route.
- **Edit access includes secrets.** Anyone with edit access to a project can open a shell in its app pods and read their environment variables.
- **Audit logs do not cover `kubectl`.** Actions taken directly on the cluster do not appear in the audit log. Refer to [Audit logs](/teams/audit-logs/#limitations).

## Networking

- **Isolation depends on the CNI.** Every network control is a Kubernetes NetworkPolicy. Orchard creates the policies but cannot tell whether your Container Network Interface (CNI) plugin enforces them, and plain Flannel does not. On a Flannel cluster, turn on `networkPolicy.enforcer.enabled` in the chart, which runs kube-router to enforce the policies. Run `orchard doctor --selftest` to check. Refer to [Enforce network policies on Flannel](/operate/tenancy-and-isolation/#enforce-network-policies-on-flannel).
- **Node blocking is approximate without Cilium.** With Cilium, Orchard denies the `host`, `remote-node`, and `kube-apiserver` entities in each tenant namespace. With any other CNI, only address exceptions computed from the node list keep tenant pods away from host-network services. Orchard cannot find a public load balancer address on its own, so add it to `PLATFORM_EXTRA_DENY_CIDRS`. Refer to [Network isolation](/operate/security/#network-isolation).
- **Outbound IPv4 only.** The tenant egress policy allows the public IPv4 internet. Apps cannot open outbound IPv6 connections.
- **No raw ports in tunnel mode.** Cloudflare Tunnel carries HTTP only, so public TCP and UDP ports and public database access are not available on a `tunnel` install. Refer to [Publish a TCP or UDP port](/deploy/networking/#publish-a-tcp-or-udp-port).
- **Public ports hide the client address.** Public ports and public databases need a layer 4 load balancer and a public IP address. The app sees a node address as the client address, not the real one. Refer to [Public TCP and UDP ports](/operate/security/#public-tcp-and-udp-ports).
- **Protected domains depend on the server.** Requests to a domain with **Password** or **Project members** protection, and with **Username and password** protection on a cluster without Cilium, pass through the Orchard server. Those domains stop responding while the server is down. Protection does not apply to raw TCP or UDP ports. Refer to [How operators enable each type](/deploy/protection/#how-operators-enable-each-type).
- **Self-signed certificates in `lan` mode.** A `lan` install gives apps self-signed certificates and serves the dashboard over plain HTTP, and passkeys need HTTPS. Refer to [Certificates](/deploy/domains/#certificates).
- **Port 80 stays open in `public` mode.** Let's Encrypt uses port 80 for every new app hostname and every renewal. If another process owns port 80 or 443, use `tunnel` mode. Refer to [Choose an ingress mode](/start/install/#choose-an-ingress-mode).

## Databases and storage

- **Postgres is the only managed database.** Run MariaDB, MongoDB, Redis, and other databases as apps from [templates](/run/templates/). They do not get managed backups or point-in-time restore. A Score file that asks for Redis or Valkey is skipped. Refer to [Can I run databases other than Postgres?](/start/faq/#can-i-run-databases-other-than-postgres).
- **Allowlisted Postgres extensions only.** Orchard refuses extensions that are not on its allowlist, such as untrusted languages and foreign data wrappers. Refer to [Allowed extensions](/data/extensions/#allowed-extensions).
- **A volume limits replicas and deploys.** On most storage classes, only one pod can write to a volume, so extra replicas do not start. An app with a volume must use the **Recreate** strategy, so it has brief downtime on every deploy. Refer to [Attach storage to an app](/deploy/storage/#limitations).
- **Volumes do not shrink.** A volume can grow on a storage class that allows expansion, but it cannot shrink.
- **`local-path` volumes stay on their node.** A pod whose volume exists only on one node cannot start on another node, so it does not move when that node fails or drains. Refer to [Remove a node from a Helm cluster](/operate/nodes/#remove-a-node-from-a-helm-cluster).
- **Standbys on one machine do not survive its loss.** On an installer host, every database instance runs on the one node. Standbys protect against a failed Postgres instance, not a lost machine. Refer to [Configure high availability](/data/high-availability/).

## Builds

- **Builds need a registry.** On a Helm install without `DOCKER_REGISTRY_PUSH` and `DOCKER_REGISTRY_PULL`, builds fail, and only prebuilt images deploy. Refer to [Image builds need a container registry](/operate/troubleshooting/#image-builds-need-a-container-registry).
- **Rootless builds need user namespaces.** Default builds fail on nodes that do not allow unprivileged user namespaces. On Ubuntu 24.04, set `kernel.apparmor_restrict_unprivileged_userns=0`. Refer to [Builds without a sandbox runtime](/operate/security/#builds-without-a-sandbox-runtime).
- **One architecture per instance.** Orchard builds images for one platform, `linux/amd64` or `linux/arm64`, set by `builders.platform` (`BUILD_PLATFORM`). It does not build multi-architecture images. When the platform is set, apps that Orchard builds run only on nodes of that architecture.
- **Some Dockerfile options are refused.** Orchard refuses `RUN --security=insecure` and `RUN --network=host` in every mode.
- **`orchard up` needs S3 storage.** Deploying a local directory needs S3-compatible storage that build pods can reach. The store on an installer host does not count. Without it, [import a GitHub repository](/deploy/deploy-from-terminal/#import-a-github-repository) instead. Refer to [Turn on local deploys](/deploy/deploy-from-terminal/#turn-on-local-deploys).
- **Compose stacks come from GitHub only.** Orchard reads the compose file from a GitHub repository. It ignores bind mounts, `network_mode`, `depends_on`, and build contexts outside the repository, and two services cannot share a volume. Refer to [How Orchard reads the file](/run/compose/#how-orchard-reads-the-file).

## Backups and recovery

- **Database backups need storage.** Backups, point-in-time restore, checkpoints, the drop guard, restore tests, and rollbacks that restore databases all need an S3-compatible bucket for the instance or the organization. The installer sets up a store on the same machine. The Helm chart does not, unless you turn on `objectStorage.local` or add S3 storage. Refer to [Back up and restore a database](/data/backups/#prerequisites).
- **The store on the server is not disaster recovery.** It sits on the same disk as the databases, so losing the disk loses the backups too. Send backups to [S3 storage](/operate/storage/) on another machine.
- **30-day recovery window.** Orchard removes backups and write-ahead log (WAL) older than 30 days, which also limits how far back point-in-time restore reaches. Refer to [Retention](/data/backups/#retention).
- **Control-plane backups are off by default.** Continuous backups of Orchard's own database are off, and the installer does not turn them on. A new installer host writes a daily dump to the store on the same machine. Refer to [Back up the control-plane database](/operate/production/#5-back-up-the-control-plane-database).
- **Instance recovery is untested.** Orchard has not tested the procedure that brings back a whole instance on a new machine end to end. Rehearse it on a spare machine before you rely on it. Refer to [Restore the control plane](/operate/backup-and-restore/#restore-the-control-plane).
- **App volumes and images are not backed up.** Back up volume data from inside the app. Images come back when you rebuild from the repository. Refer to [What to back up](/operate/backup-and-restore/#what-to-back-up).
- **A restore needs the original secrets key.** Without the original `SECRETS_ENCRYPTION_KEY`, Orchard cannot read the stored secrets, even after a successful restore.

## Integrations

- **Bitbucket app passwords do not work.** Bitbucket Cloud does not accept app passwords. Link it with an Atlassian API token, an access token, or **Sign in with Bitbucket**, and reconnect a provider that you linked with an app password. Refer to [Replace a Bitbucket app password](/deploy/git-providers/#replace-a-bitbucket-app-password).
- **Git connections use HTTPS.** A Git connection needs an `https://` base URL. For **Any Git host**, Orchard cannot check the token before the first build, and you add the webhook to the repository yourself. Refer to [Deploy from GitLab, Gitea, and others](/deploy/git-providers/).
- **GitHub auto-deploy needs the GitHub App.** A public repository deploys without it, but a push builds only when a GitHub App on the instance can see the repository. Refer to [Deploy from GitHub](/deploy/github/).
- **No email without SMTP.** Without SMTP settings, Orchard sends no email. Invitations are links that you copy, the sign-in pages hide email codes, and email notification destinations fail to deliver. Refer to [Set up email](/operate/finishing-setup/#set-up-email).
- **SAML restrictions.** Orchard rejects IdP-initiated sign-in, encrypted assertions, SHA-1 signatures, and responses that are not signed on both the response and the assertion. Refer to [SAML requirements](/teams/sso/#saml-requirements).
- **The Terraform provider is not on a public registry.** Build the provider and point your client at the build. Refer to [Install the provider](/run/terraform/#install-the-provider).

## Observability

- **Request metrics need Traefik or HAProxy.** Request, error, and latency charts come from the ingress controller's metrics, and Orchard reads them from Traefik and HAProxy only. With another controller, apps run, but these charts stay empty. Refer to [Point app metrics at your ingress controller](/operate/finishing-setup/#point-app-metrics-at-your-ingress-controller).
- **Request logs and attack signals need Traefik or HAProxy.** The **Requests** view and the attack card read access logs, which Vector parses only for Traefik and the haproxytech HAProxy controller. Refer to [Access logs](/operate/logs/#access-logs).
- **The metrics and log stores have no authentication.** Do not expose VictoriaMetrics or VictoriaLogs outside the cluster. Refer to [What you must do](/operate/tenancy-and-isolation/#what-you-must-do).

## Extensions (grafts)

- **Grafts run with full server privileges.** A graft runs inside Orchard with no sandbox. It can read your secrets and database, sign in as any user, and change the apps on your cluster, and its migrations run with Orchard's database user. Install only grafts whose publisher you would give full control of your server. Refer to [Trust](/grafts/install/#trust).
- **Community graft updates are not reviewed by hand.** An Orchard maintainer reviews a community graft when it is first listed. Later versions pass automated checks only, and Orchard does not check taps. The default trust policy, `listed`, loads community grafts. To load only Orchard's own grafts, set it to `official`. Refer to [Where grafts come from](/grafts/install/#where-grafts-come-from).

## Platform support

- **Installer hosts.** The installer needs Linux with systemd, an amd64 or arm64 CPU, an IPv4 address, root access, and at least 20 GB of free disk on `/var/lib`. It refuses other architectures and less disk. Continuous integration tests it on Ubuntu 24.04 and Ubuntu 26.04 only. Refer to [Prerequisites](/start/install/#prerequisites).
- **No IPv6-only servers.** The installer stops on a server with no IPv4 address, because GitHub and ghcr.io have no IPv6 addresses and Orchard listens on IPv4 only. NAT64 is unsupported and untested. Refer to [The installer stops on an IPv6-only server](/operate/troubleshooting/#the-installer-stops-on-an-ipv6-only-server).
- **No installs inside Docker.** k3s cannot nest its overlayfs snapshotter in a Docker container. Use a virtual machine or a physical machine.
- **Kubernetes 1.30 or later for the Helm chart.** The chart installs `ValidatingAdmissionPolicy` objects. Sandboxed database pods also need a Kubernetes version that serves `MutatingAdmissionPolicy`. Refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).
- **You install the sandbox runtimes.** Orchard does not install gVisor or Kata, because they are node-level and vary by distribution. Kata builds need KVM on the build nodes. Refer to [Turn on kernel isolation](/operate/security/#turn-on-kernel-isolation).
- **Kubernetes is the source of truth.** Orchard adopts changes made with `kubectl`, except to security objects, which it restores. Most dashboard reads come from Orchard's copy of cluster state, and a failed read from Kubernetes does not mark a resource as gone. Refer to [Architecture](/operate/architecture/#reads).

## Related resources

- [Tenancy and isolation](/operate/tenancy-and-isolation/) - Review every isolation guarantee, what you must configure for it, and what Orchard does not guarantee.
- [Go to production](/operate/production/) - Work through the settings to check before other people depend on your instance.
