---
title: Upgrade Orchard
description: Upgrade an Orchard instance installed with the one-command installer or the Helm chart, and understand what an upgrade changes.
sidebar:
  order: 4
---

To upgrade Orchard, use the command that matches how you installed it. Take a backup of the control-plane database before a major upgrade. This database holds every organization, project and app definition on the instance.

## Upgrade an installer host

Run the following command on the host:

```bash
sudo orchardctl update
```

`orchard-update` is the same command. It upgrades the chart with `/etc/orchard/values.yaml`, restarts deployments that use a moving image tag, and refreshes the host commands. For the full sequence, refer to [`orchardctl update`](/operate/host-commands/#update).

If you chose automatic updates during installation, a nightly systemd timer runs the same command.

An upgrade turns on, once, features that newer releases run by default. Orchard prints each change. If you turn a feature off afterwards, it stays off. For the list, refer to [New defaults on an existing host](/operate/host-commands/#new-defaults-on-an-existing-host).

## Re-run the installer

You can also re-run the installer on an existing host. A re-run:

- Keeps your secrets, custom environment variables and volume sizes.
- Does not restart k3s unless the registry mirror configuration changed.

## Upgrade a Helm install

Run the following command:

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard -f my-values.yaml
```

In automated pipelines, add `--version` to pin a chart version.

## Database migrations

Schema migrations run when the server starts. Upgrade forward. An older server with a newer schema is not supported.

## Effect on running apps

Upgrading the control plane does not restart tenant apps. The server, frontend and MCP pods roll out, and apps keep serving during the rollout.

## Roll back an upgrade

You can roll back the release with `helm rollback`. If the new version migrated the schema, the old version may not run against it. If downtime matters, test upgrades on a non-production instance first.

## Related resources

- [Host commands](/operate/host-commands/)
- [Going to production](/operate/production/)
