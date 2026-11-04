---
title: Turn resource limits on or off
description: Choose whether Orchard holds apps and databases to a CPU and memory limit on your instance, and apply the change with a restart.
sidebar:
  order: 7
---

To let apps and databases use all of a server's resources, turn resource limits off. To hold each app and database to a set amount of CPU and memory, turn resource limits on.

This setting applies to the whole instance. Only a superadmin can change it. Limits are on unless someone chooses otherwise, so an instance that you upgrade keeps its limits. A new instance asks during setup.

## Compare the settings

|                                 | Limits on                                                                         | Limits off                                            |
| ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| CPU and memory for an app       | Its own limits, or the organization default                                       | All of the server's resources                         |
| Risk                            | An app that uses more memory than its limit is killed                             | One app can use up the whole server                   |
| Organization and project caps   | Checked when you create, scale, or resize                                         | Not checked                                           |
| Member allowances               | Checked when you create, scale, or resize                                         | Not checked                                           |
| The resource picker             | Shows the size controls                                                           | Shows that limits are off                             |

With limits off, Orchard still reserves a small amount for each app so that it can place the app on a node: 50 millicores of CPU and 64 MB of memory. A database reserves at least 100 millicores and 256 MB.

## When a change applies

A change does not restart anything. Each app and database keeps its current limits until one of the following happens to it:

- You select **Restart**.
- You select **Redeploy**, or a new build finishes.
- You change the image of the app, or roll it back.

Other changes, such as editing variables or scaling, keep the current limits. A pod that crashes and comes back also keeps them.

### When the cluster replaces a pod

The cluster can replace a pod at any time, for example when it drains a node or evicts the pod. After you turn limits on, what the new pod gets depends on whether a cap applies:

- If its organization or project has a CPU or memory cap, the new pod gets the default limit at that point. The pod starts and keeps that limit.
- If there is no cap, the new pod has no limit until the next restart.

A new pod gets more than the default if it already reserves more. A database gets at least 512 MB, and enough for its `shared_buffers` setting.

While apps and databases run without limits, Orchard raises the quota in the cluster so that their new pods fit, even if they need more than the cap. New apps and databases still count against the cap.

After you turn limits off, a pod that the cluster replaces keeps its limits until the next restart.

## Turn limits off

1. Go to **Instance admin** > **Configuration** > **Resource limits**.
2. Turn off **Limit apps and databases**.
3. Select **Turn off limits**.
4. To apply the change now, select **Restart** on each app and database.

Your apps and databases then run without limits. Orchard keeps the sizes that you set, and uses them again if you turn limits back on.

## Turn limits on

:::caution
Every app and database without its own limits gets the organization default at its next restart. If its organization or project has a cap, a pod that the cluster replaces before then gets the default at that point. An app that uses more memory than that may be killed.
:::

1. Go to **Instance admin** > **Configuration** > **Resource limits**.
2. Turn on **Limit apps and databases**.
3. Review the number of apps and databases that this affects.
4. Enter **Default memory limit** and **Default CPU limit** for each organization. Leave a field blank to use the instance default.
5. Select **Turn on limits**.
6. To apply the change now, select **Restart** on each app and database.

## Find apps that have not restarted

After a change, the **Resource limits** section shows how many apps and databases still run with the old setting. An app that needs a restart also shows `Restart to apply the resource limits setting.` on its page.

## Choose at install

To choose during a non-interactive install, pass `--limits` to the installer. The setup page then skips the question.

```bash
install.sh --limits off
```

You can also set `ORCHARD_LIMITS` instead of the flag. Orchard stores your answer as the current choice, so you can still change it in **Instance admin**.

## Lock the setting

To lock the setting, set `INSTANCE_RESOURCE_LIMITS` to `on` or `off` on the server. The variable overrides the stored choice, and **Instance admin** shows the setting as read-only.

On an installer host, run the following command:

```bash
sudo orchardctl env set INSTANCE_RESOURCE_LIMITS off --apply
```

This restarts the Orchard server, but not your apps or databases. They pick up the setting at their next restart.

To unlock the setting, run the following command:

```bash
sudo orchardctl env unset INSTANCE_RESOURCE_LIMITS --apply
```

Orchard keeps the value that was locked. You can then change it in **Instance admin**.

## Change the default limits

When limits are on, an app or database without its own size uses the first value that is set:

1. The organization default. Change it in **Instance admin** > **Organizations** > **Resource quotas**.
2. The instance default, from the following variables:

| Variable                     | Applies to | Default | Minimum |
| ---------------------------- | ---------- | ------- | ------- |
| `DEFAULT_APP_MEMORY_MB`      | Apps       | `128`   | None    |
| `DATABASE_DEFAULT_MEMORY_MB` | Databases  | `1024`  | `512`   |

A database never gets less than 512 MB, including when the organization default is lower, because Postgres runs its backups in the same memory. A database that already runs with less keeps its size until its next restart.

The installer sets `DEFAULT_APP_MEMORY_MB` on a new install, based on the memory of the machine:

| Machine memory | `DEFAULT_APP_MEMORY_MB` |
| -------------- | ----------------------- |
| Under 8 GB     | `256`                   |
| Up to 16 GB    | `512`                   |
| Over 16 GB     | `1024`                  |

## Related resources

- [Set quotas](/teams/quotas/)
- [Scale an app and set resources](/deploy/scaling/)
- [Manage organizations](/operate/manage-organizations/)
- [Host commands](/operate/host-commands/)
