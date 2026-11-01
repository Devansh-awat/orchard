---
title: Upgrades
description: Moving to a new version of Orchard.
sidebar:
  order: 4
---

## Installer-based instances

If you used the one-command installer:

```bash
orchard-update
```

It re-applies the chart with `/etc/orchard/values.yaml`. If you chose automatic
updates at install time, a nightly systemd timer runs the same thing.

That values file is the source of truth for the instance. Edit it, run
`orchard-update`, and the change is applied.

An upgrade also turns on, once, features that newer releases run by default:
metrics, the log store, image scanning, local backup storage when none is
configured, and Traefik's JSON access log. Each change is printed, and turning
one back off afterwards sticks. See
[New defaults on an existing host](/operate/host-commands/#new-defaults-on-an-existing-host).

## Chart-based instances

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --namespace orchard -f my-values.yaml
```

Pin a chart version in anything automated so an upgrade happens when you decide
it does, not when a tag moves.

## Database migrations

Schema migrations run on server start. Roll forward rather than back: an older
server against a newer schema is not a supported combination.

Take a backup of the control-plane database before a major upgrade. It holds
every organization, project and app definition on the instance.

## Tenant impact

Upgrading the control plane does not restart tenant apps. Their pods keep serving
while the API restarts; the dashboard is briefly unavailable, deploys queue.

## Rolling back

Helm can roll the release back, but if the new version migrated the schema, the
old code may not run against it. Test upgrades on a non-production instance if
downtime matters.
