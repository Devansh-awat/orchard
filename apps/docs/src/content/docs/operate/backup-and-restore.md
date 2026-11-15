---
title: Back up and restore an instance
description: Learn what an Orchard instance needs backed up, where each part lives, and how to bring back the control plane on a new machine.
sidebar:
  order: 8
---

To recover an Orchard instance after you lose a machine, you need more than database backups. Orchard keeps its own records in a control-plane database, your apps keep their data in their own databases and volumes, and the settings that tie them together live in a values file. This page lists where each part lives, how to protect it, and how to bring back the control plane.

## What to back up

| Data                       | Where it lives                                                                                                         | How to protect it                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings and secrets       | `/etc/orchard/values.yaml` on an installer host. On a Helm install, your values file and the `orchard-secrets` Secret. | Copy them somewhere safe, off the machine. They contain secrets, so protect the copy.                                                      |
| Control-plane database     | The `orchard-db` CloudNativePG cluster in the `orchard` namespace.                                                     | Off by default. Turn on backups. Refer to [Back up the control-plane database](/operate/production/#5-back-up-the-control-plane-database). |
| App databases              | Each database's own cluster.                                                                                           | Orchard backs them up to object storage. To survive the loss of a machine, use [S3 storage on another machine](/operate/storage/).         |
| App volumes                | PersistentVolumeClaims in each project's namespace.                                                                    | Orchard does not back up app volumes. Back up the data from inside the app.                                                                |
| Uploads and build contexts | Object storage.                                                                                                        | Use your storage provider's replication or versioning.                                                                                     |
| Built images               | The container registry. On an installer host, this is zot on the server.                                               | Not backed up. A rebuild from the repository recreates an image.                                                                           |

Continuous backups of the control-plane database are off by default, and the installer does not turn them on. A new installer host writes a daily dump of this database to the object store on the same machine, which does not survive the loss of that machine.

:::caution
Keep `SECRETS_ENCRYPTION_KEY`. Without the original key, Orchard cannot read the secrets stored in the control-plane database, even after a successful restore.
:::

## How app databases are backed up

CloudNativePG archives each database's write-ahead log (WAL) and takes base backups to object storage. It does this in one of two ways:

| Method                  | Used by                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The Barman Cloud plugin | New installer hosts, and any instance with `CNPG_BARMAN_PLUGIN=on`. Each database has an `ObjectStore` and a backup sidecar. |
| Built-in Barman Cloud   | Older installer hosts and Helm installs without `CNPG_BARMAN_PLUGIN=on`.                                                     |

CloudNativePG 1.31 removes the built-in method, and a database that still uses it stops taking backups after that upgrade. Before CloudNativePG 1.31 reaches your cluster, move every database to the plugin. Refer to [Move database backups to the Barman Cloud plugin](/operate/upgrades/#move-database-backups-to-the-barman-cloud-plugin).

Both methods write the same archive format to the same path, so a backup taken with one method restores with the other. To recover a database on a new cluster, install CloudNativePG, cert-manager, and the Barman Cloud plugin first.

## Restore the control plane

The chart always creates the control-plane database empty. To restore it, recover the backup into a separate cluster, and then load it into the new instance.

:::caution[Untested procedure]
Orchard has not tested this procedure end to end. Run it on a spare machine before you rely on it, and repeat the test after major upgrades.
:::

1. Install Orchard on the new machine with your saved settings. On an installer host, copy your saved file to `/etc/orchard/values.yaml` first, with mode `0600`, and then run the installer. On a Helm install, recreate the `orchard-secrets` Secret, and install with your values file. Keep the same dashboard domain. Do not claim the instance.

2. Recover your latest backup into a scratch cluster. Follow the [test restore](/operate/production/#5-back-up-the-control-plane-database) steps, and wait for the `orchard-db-restore` cluster to be ready.

3. Dump the recovered database:

   ```bash
   kubectl -n orchard-restore-test exec orchard-db-restore-1 -c postgres -- \
     pg_dump -Fc -d orchard > orchard.dump
   ```

4. Stop the server, and load the dump into the new instance:

   ```bash
   kubectl -n orchard scale deploy/server --replicas=0
   kubectl -n orchard exec -i orchard-db-1 -c postgres -- \
     pg_restore --clean --if-exists --no-owner --role=orchard -d orchard < orchard.dump
   ```

5. Start the server again, with the number of replicas that you run:

   ```bash
   kubectl -n orchard scale deploy/server --replicas=1
   kubectl -n orchard rollout status deploy/server --timeout=10m
   ```

6. Delete the `orchard-restore-test` namespace.

## After the restore

The control-plane database holds Orchard's records. It does not hold the workloads that ran on the lost cluster. Check each project after the restore:

- Redeploy each app. A rebuild recreates an image that the new registry does not have.
- Restore each database from its backup. For the options, refer to [Back up and restore a database](/data/backups/#restore-a-database). The new instance must be able to reach the same object storage.
- Restore the contents of any app volumes yourself.

## Related resources

- [Add S3 storage](/operate/storage/) - Keep database backups and uploads off the machine.
- [Schedule database dumps](/operate/database-dumps/) - Run `pg_dump` on a schedule and upload the result to S3.
- [Upgrade Orchard](/operate/upgrades/) - Upgrade an instance, and take a backup first.
