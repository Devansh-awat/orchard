---
title: Upgrade Orchard
description: Upgrade an Orchard instance installed with the one-command installer or the Helm chart, pin a version, find release notes, and understand what an upgrade changes.
sidebar:
  order: 4
---

To upgrade Orchard, use the command that matches how you installed it. An upgrade rolls out new control-plane pods and runs database migrations. It does not restart your apps.

Before a major upgrade, take a [backup of the control-plane database](/operate/production/#5-back-up-the-control-plane-database). This database holds every organization, project, and app definition on the instance. Its continuous backups are off by default, so check that you turned them on.

## Upgrade an installer host

Run the following command on the host:

```bash
sudo orchardctl update
```

`orchard-update` is the same command. It upgrades the chart to the newest release with `/etc/orchard/values.yaml`, restarts deployments that use a moving image tag, and refreshes the host commands. For the full sequence, refer to [`orchardctl update`](/operate/host-commands/#update).

If you chose automatic updates during installation (`--updates automatic`), a nightly systemd timer runs the same command. To stop it, run `sudo systemctl disable --now orchard-update.timer`.

## Pin a version on an installer host

An installer host runs the server, frontend, and MCP images of the chart it installed. A pod restart does not change their version. `orchardctl update` installs the newest chart, which moves them together. To stay on one release until you choose to move:

1. Turn off nightly updates, because the timer always installs the newest chart:

   ```bash
   sudo systemctl disable --now orchard-update.timer
   ```

2. Run the installer with `--chart-version`. On an existing host, the re-run keeps your answers and settings. If the values file sets `latest` image tags, the re-run removes them, so the server and frontend run the images of that chart version.

   ```bash
   sudo ./install.sh --chart-version <VERSION>
   ```

3. To move to another release later, pass the version to `orchardctl update`. Any extra arguments go to `helm upgrade`.

   ```bash
   sudo orchardctl update --version <VERSION>
   ```

   Without `--version`, `orchardctl update` installs the newest chart.

`orchardctl update` also applies k3s patches and newer third-party images, independent of the Orchard version. To hold those too, add these lines to `/etc/orchard/env`:

```bash
ORCHARD_K3S_UPDATES=off
ORCHARD_ADDON_UPDATES=off
```

If you turn them off, apply their security fixes yourself. For what each one covers, refer to [Security updates](#security-updates).

## Find release notes

Release notes are on [GitHub Releases](https://github.com/hackclub/orchard/releases). Each service has its own release, tagged `<service>/v<version>`, such as `server/v2.95.4` or `frontend/v1.87.0`. Each release lists its changes, with a link to each commit.

The chart has no release page of its own. Its version is the highest version among the services it ships, so the release with that number is the newest change in that chart. To see the chart version you run, use the following command:

```bash
helm list -n orchard
```

After a dashboard release, the dashboard shows its release notes to each person once. The notes come from `assets.orchard.my`. To turn them off, set `UPDATES_URL=off`.

## Upgrade k3s

`orchardctl update` also applies the latest k3s patch, from the k3s release channels. To see your version, or to move to a newer minor version, use the following commands:

```bash
sudo orchardctl k3s
sudo orchardctl k3s upgrade
```

For what each step does, refer to [`orchardctl k3s`](/operate/host-commands/#k3s).

## Security updates

Most parts of an instance get security fixes without an Orchard release:

| Part                                                       | How it gets security fixes                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| k3s, Kubernetes, and containerd                            | `orchardctl update` applies patches from the k3s release channels. `orchardctl k3s upgrade` moves to a new minor version.                                                      |
| Postgres minor versions                                    | Orchard applies them from the [CloudNativePG image catalog](/data/upgrades/).                                                                                                  |
| The host operating system                                  | Your distribution's updates. Orchard does not change them.                                                                                                                     |
| Traefik, CloudNativePG, and cert-manager                   | `orchardctl update` upgrades them from their own charts. Refer to [Third-party update policy](#third-party-update-policy).                                                     |
| Redis, pgbouncer, BuildKit, and the metrics and log stores | `orchardctl update` installs newer versions from their own registries. Refer to [Third-party update policy](#third-party-update-policy). To see them, run `orchardctl images`. |
| Railpack                                                   | A new Orchard chart, because a version mismatch breaks builds. `orchardctl images` tells you when one is out.                                                                  |
| Orchard                                                    | A new Orchard chart. `orchardctl update` installs it.                                                                                                                          |

Security fixes in third-party components do not wait for an Orchard release. A new major version of a third-party component needs a person, because it can change behavior. `orchardctl update` tells you when one is out. To turn off these updates, add `ORCHARD_ADDON_UPDATES=off` to `/etc/orchard/env`.

Upgrading CloudNativePG does not restart your databases, because the installer turns on in-place updates of the instance manager.

An upgrade turns on, once, features that newer releases run by default. Orchard prints each change. If you turn a feature off afterward, it stays off. For the list, refer to [New defaults on an existing host](/operate/host-commands/#new-defaults-on-an-existing-host).

`orchardctl update` also sets `kernel.apparmor_restrict_unprivileged_userns` to `0` where it is `1`, such as on Ubuntu 24.04, because rootless builds need user namespaces. It skips this when `builderSandbox.enabled` or `builders.allowPrivilegedOnHost` is `true`.

## Third-party update policy

`orchardctl update` installs new versions of Traefik, CloudNativePG, cert-manager, and the third-party images from their own sources. It does not wait for an Orchard release. Each new version goes through the following rules:

1. **Version class**: A new major version never installs on its own. `orchardctl update` prints a note, so that you can read its upgrade notes first. Below version 1.0, a new minor version counts as a new major version. For example, `0.61.0` to `0.61.3` installs, and `0.61.0` to `0.62.0` needs a person. Redis, pgbouncer, and BuildKit take patch versions only. cloudflared uses calendar versions and takes any newer version.
2. **Soak period**: A version installs only after it has been public for 7 days. If a release turns out to be broken or compromised during that time, and its publisher replaces it, your instance never installs it. A version without a publication date waits.
3. **Security fast track**: If [OSV.dev](https://osv.dev) lists a vulnerability in the running version, the update installs a fixed version at once, without the soak period. It picks the version that fixes the most of those advisories and adds no new advisory. If more than one version qualifies, it prefers the newest one that has soaked, then the oldest one that has not. The command prints `security update: <advisory> affects <running version>, moving to <new version>`.

The fast track follows the version class rules. If only a new major version fixes a vulnerability, `orchardctl update` names the version that fixes it and leaves the upgrade to you.

If OSV.dev does not answer, every version waits for the soak period. Missing advisory data never blocks an update, and never skips the soak period. When OSV.dev answers, the update also skips a version that has an advisory that the running version does not have.

`orchardctl update` respects versions in `/etc/orchard/images-held`, including on the fast track. It sends OSV.dev package names and version numbers only, and nothing about your instance.

### Settings

Set these in `/etc/orchard/env`:

| Variable                   | Default | Effect                                                                                       |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `ORCHARD_UPDATE_SOAK_DAYS` | `7`     | The number of days that a version must be public before it installs. `0` turns off the wait. |
| `ORCHARD_ADDON_UPDATES`    | `on`    | `off` turns off add-on and image updates, including security fixes.                          |

### Publication dates

| Source                                                              | Publication date                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Traefik, CloudNativePG, and cert-manager charts                     | The `created` field of the version in the chart repository's `index.yaml`. |
| Images on Docker Hub                                                | The time that Docker Hub recorded for the last push of the tag.            |
| Images on `quay.io`                                                 | The time that `quay.io` recorded for the tag.                              |
| Images on other registries, such as `ghcr.io` and `registry.k8s.io` | The `created` time in the image configuration.                             |

A new push to an existing Docker Hub tag starts its soak period again. The publisher's build sets the `created` time in an image configuration and in a chart index, so treat those dates as the publisher's claim.

### Advisory sources

`orchardctl update` checks each component against a package that OSV.dev indexes. For a chart, it checks the version of the application that the chart installs.

| Component                   | OSV.dev package                                                          |
| --------------------------- | ------------------------------------------------------------------------ |
| Traefik                     | Go module `github.com/traefik/traefik/v3`, for the running major version |
| CloudNativePG               | Go module `github.com/cloudnative-pg/cloudnative-pg`                     |
| cert-manager                | Go module `github.com/cert-manager/cert-manager`                         |
| Redis                       | Git repository `https://github.com/redis/redis`                          |
| BuildKit                    | Go module `github.com/moby/buildkit`                                     |
| skopeo                      | Go module `github.com/containers/skopeo`                                 |
| VictoriaMetrics and vmagent | Go module `github.com/VictoriaMetrics/VictoriaMetrics`                   |
| kube-state-metrics          | Go module `k8s.io/kube-state-metrics/v2`                                 |
| node-exporter               | Go module `github.com/prometheus/node_exporter`                          |
| Vector                      | Git repository `https://github.com/vectordotdev/vector`                  |
| Trivy                       | Go module `github.com/aquasecurity/trivy`                                |
| versitygw                   | Go module `github.com/versity/versitygw`                                 |
| aws-cli                     | Git repository `https://github.com/aws/aws-cli`                          |
| zot                         | Go modules `zotregistry.dev/zot` and `zotregistry.dev/zot/v2`            |
| cloudflared                 | Git repository `https://github.com/cloudflare/cloudflared`               |

pgbouncer and VictoriaLogs have no OSV.dev package that matches their release versions, so only the soak period applies to them. OSV.dev lists Vector advisories without the affected release versions, so a Vector advisory does not start the fast track.

## Re-run the installer

You can also re-run the installer on an existing host. A re-run:

- Keeps your secrets, chart values, environment variables, and volume sizes.
- Changes a value only when you change an answer that it depends on, and prints each change.
- Saves a copy of the values file before it changes the file.
- Does not restart k3s unless the registry mirror configuration changed.

Without `--chart-version`, a re-run installs the newest chart. For more information, refer to [Run the installer again](/start/install/#run-the-installer-again).

## Upgrade a Helm install

Run the following command:

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version <VERSION> --namespace orchard -f my-values.yaml --server-side=false
```

On Helm 3, leave out `--server-side=false`, because Helm 3 does not have this flag. For the reason Helm 4 needs it, refer to [Upgrade the chart](/start/install/#upgrade-the-chart).

Pass `--version` on every upgrade. Without it, Helm installs the newest chart. A published chart sets the server, frontend, MCP, and backup proxy images to the versions in that release, so the chart version pins them too.

## Database migrations

Schema migrations run when the server starts. Upgrade forward. An older server with a newer schema is not supported.

## Effect on running apps

Upgrading the control plane does not restart tenant apps. The server, frontend, and MCP pods roll out, and apps keep serving during the rollout.

## Roll back an upgrade

You can roll back the release with `helm rollback`. If the new version migrated the schema, the old version may not run against it. If downtime matters, test upgrades on a non-production instance first.

## Upgrade from an earlier version

### Turn off the Postgres superuser on older databases

Orchard creates dedicated databases with the CloudNativePG `postgres` superuser login turned off (`enableSuperuserAccess: false`). Orchard never uses that login. Databases created by earlier versions keep it until you run the script in `apps/server/scripts/cnpg-disable-superuser.sh` from a checkout of the repository, with `kubectl` access to the cluster.

The script patches one cluster at a time, and stops if any instance pod restarts:

```bash
apps/server/scripts/cnpg-disable-superuser.sh                   # dry run, lists clusters
apps/server/scripts/cnpg-disable-superuser.sh --apply --limit 1 # one cluster first
apps/server/scripts/cnpg-disable-superuser.sh --apply
```

### Refresh BuildKit daemon policies

Persistent BuildKit daemons do not hold the registry login, and the chart's `buildkit-daemon-network-policy` limits their egress. If your instance ran persistent daemons before the chart included that policy, upgrade the chart so that the policy exists, and check that `builders.registryEgress` lists your registry.

## Related resources

- [Back up and restore an instance](/operate/backup-and-restore/) - Learn what to back up before an upgrade and how to bring back the control plane.
- [Host commands](/operate/host-commands/) - Review every `orchardctl` command, including `update` and `k3s`.
- [Upgrade and roll back grafts](/grafts/upgrades/) - Upgrade extensions separately from Orchard.
