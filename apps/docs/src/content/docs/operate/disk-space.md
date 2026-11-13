---
title: Free disk space
description: Find what uses disk on an Orchard server, and prune the build cache and old container images by hand or automatically.
sidebar:
  order: 7
---

Every deploy adds to the disk of the server. A build writes layers to the build cache, the registry stores the new image, and the node pulls a copy of it to run. Orchard removes old data automatically. This page explains what it removes, when, and how to free space now.

## Find what uses the disk

Run these commands on the server:

```sh
df -h /var/lib
sudo du -sh /var/lib/rancher/k3s/storage/* | sort -h
sudo du -sh /var/lib/rancher/k3s/agent/containerd
sudo orchardctl image-gc
```

`/var/lib/rancher/k3s/storage` holds the volumes of Orchard and your apps. The names end in the namespace and the volume name.

| Volume                                | What it holds                                                                   | What frees it                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `orchard-builders_buildkit-cache`     | Layers from earlier builds, so that builds can skip unchanged steps.            | [The build cache](#the-build-cache)                                                                               |
| `orchard_zot-data`                    | Your app images. Orchard keeps the 10 newest images of each app, for rollbacks. | Each deploy deletes older images. The registry frees their space once a day.                                      |
| `orchard-metrics_data-victorialogs-0` | Logs.                                                                           | `logs.retention` and `logs.maxDiskSpaceUsage`. For more information, refer to [Logs](/operate/logs/).             |
| `orchard-object-storage_*`            | Database backups and dumps.                                                     | The retention of each backup. For more information, refer to [Back up and restore](/operate/backup-and-restore/). |

`/var/lib/rancher/k3s/agent/containerd` holds the images that the node pulled to run containers. For more information, refer to [Old container images](#old-container-images).

:::note
The installer gives each volume a size, but the `local-path` storage of k3s does not enforce it. A volume can grow until the disk is full. Orchard enforces the size of the build cache itself.
:::

## The build cache

Each environment has its own cache, with a directory for each app. A build reads the layers of the previous build of the same app, then replaces them with its own. Layers that the new build no longer uses are removed with the old cache.

Superadmins manage the cache in **Instance admin** > **Build cache**.

### Prune the cache by hand

1. Go to **Instance admin** > **Build cache**. The page shows the size of the cache and of each environment.
2. Select one of these:
   - **Prune idle caches** removes the cache of each environment that has not built in the last hour.
   - **Prune everything** removes the cache of every environment.

Orchard never removes the cache of an environment that has a build running. The next build of a pruned environment starts from scratch and takes longer.

### Prune the cache automatically

Before each build, Orchard removes:

- The cache of each environment and app that has not built for **Remove caches unused for**. The default is 14 days.
- The caches that were used least recently, until the cache is under **Size budget**. The installer sets the budget to the size of the cache volume. The chart has no budget by default.
- The caches that were used least recently, until the disk is 60% full, when the disk is more than 80% full.

Orchard never removes a cache that was used in the last hour, because a build may still be using it.

To change the budget or the number of days, go to **Instance admin** > **Build cache** > **Automatic pruning**. The values that you save there override the chart.

| Chart value                             | Environment variable          | Default                                                     |
| --------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `builders.localCache.evict.maxGiB`      | `BUILDKIT_CACHE_MAX_GIB`      | No budget. The installer sets the size of the cache volume. |
| `builders.localCache.evict.maxAgeDays`  | `BUILDKIT_CACHE_MAX_AGE_DAYS` | `14`                                                        |
| `builders.localCache.evict.highPct`     | `BUILDKIT_CACHE_HIGH_PCT`     | `80`                                                        |
| `builders.localCache.evict.targetPct`   | `BUILDKIT_CACHE_TARGET_PCT`   | `60`                                                        |
| `builders.localCache.evict.idleMinutes` | `BUILDKIT_CACHE_IDLE_MINUTES` | `60`                                                        |

### Turn off the build cache

Go to **Instance admin** > **Build cache** and turn off **Reuse layers between builds**. Builds then start from scratch every time. They take longer, and they write nothing to the cache. The cache that is already on disk stays until you prune it.

To remove the cache volume, set `builders.localCache.enabled` to `false`:

```sh
sudo orchardctl config set builders.localCache.enabled false --apply
```

## Old container images

To run an app, the node pulls its image into `/var/lib/rancher/k3s/agent/containerd`. The images of earlier deploys stay there until the kubelet removes them. By default, the kubelet waits until the disk is 85% full, then frees space down to 80%. Orchard changes this so that the kubelet:

- Starts to remove unused images when the disk is 70% full.
- Frees space down to 50%.
- Removes any image that no container has used for 72 hours.

An image that the node removes stays in the registry. The node pulls it again if it needs it, for example to roll back, to start a stopped app, or to run a build or a backup.

### Show the settings

```sh
sudo orchardctl image-gc
```

The output shows the settings, how full the disk is, and any setting elsewhere on the server that overrides Orchard's.

### Change the settings

```sh
sudo orchardctl image-gc set --high 80 --low 60
sudo orchardctl image-gc set --max-age 7d
```

| Flag               | Meaning                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--high <percent>` | The disk usage that starts a collection, from 1 to 99.                                                                                                        |
| `--low <percent>`  | The disk usage that a collection frees down to. It must be less than `--high`.                                                                                |
| `--max-age <age>`  | Remove images that no container has used for this long, such as `72h` or `3d`, from `1h` to `365d`. `off` removes images only when the disk reaches `--high`. |

A flag that you leave out keeps its value. To go back to Orchard's defaults, run `sudo orchardctl image-gc reset`. To go back to the defaults of the kubelet, run `sudo orchardctl image-gc set --high 85 --low 80 --max-age off`.

`set` and `reset` write `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/05-orchard-image-gc.conf`, and restart k3s when the file changed. Your apps keep running while k3s restarts, but the API pauses for a moment.

The kubelet counts how long an image was unused from when the kubelet last started. A restart of k3s starts every count again.

### Remove unused images now

```sh
sudo orchardctl image-gc prune
```

This removes every image that no running container uses, and prints how much space it freed. That includes the images of stopped apps, and of jobs such as builds and backups. The node pulls them again when it needs them.

### Existing servers

A new install starts with Orchard's settings. On an existing server, `sudo orchardctl update` writes them when the file does not exist yet. It never changes the file after that. An update runs the `orchardctl` that is already on the server, so a server may need two updates before it gets the settings. To get them now, run `sudo orchardctl image-gc reset`.

These settings need k3s 1.32 or newer. On an older k3s, the kubelet ignores the file, and `sudo orchardctl image-gc` warns you.

## Greenhouse machines

If you added [Greenhouse](/operate/greenhouse/), each machine keeps a home volume, 10 GiB by default, until you delete the machine. A stopped machine keeps its volume. To free the space, delete the machines that you no longer need.
