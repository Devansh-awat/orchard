---
title: Go to production
description: Prepare an Orchard instance for production by checking secrets, signups, TLS, backups, isolation, quotas, email and version pinning.
sidebar:
  order: 5
---

To prepare a trial Orchard instance for real work, complete the following steps in order. The one-command installer leaves some of these settings for you to decide.

## Prerequisites

- A running Orchard instance. For installation, refer to [Install](/start/install/).
- Root access on the host, or `kubectl` and `helm` access to the cluster.

## 1. Check your secrets

The installer generates secrets. An instance assembled by hand may still use example values.

| Variable                 | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `JWT_SECRET`             | Signs sessions. Anyone who knows this value can create a session.           |
| `SECRETS_ENCRYPTION_KEY` | Encrypts stored secrets. Orchard cannot save secrets without it.            |

Store both in a Kubernetes Secret. Do not store them in a values file in a repository.

:::caution
Changing `SECRETS_ENCRYPTION_KEY` makes existing stored secrets unreadable. Set it once, before anyone stores secrets.
:::

## 2. Close signups

The default for the chart and the installer is `invite_only`. Claiming the instance works in every mode.

```yaml
signupMode: invite_only # or: closed
```

With `open` on a public URL, anyone who finds the URL can create an account and run workloads on your hardware.

## 3. Check your superadmins

A new instance has a single-use setup token that is valid for 24 hours. Redeem it with the account that should own the instance. For more information, refer to [Install](/start/install/#claim-the-instance).

After you claim the instance, go to **Instance admin** > **Users** and confirm that the list of superadmins is correct.

## 4. Check TLS settings

Set the following server variables:

```bash
SESSION_COOKIE_SECURE=true
TRUST_PROXY=1
```

- `SESSION_COOKIE_SECURE=true` stops browsers from sending session cookies over plain HTTP.
- `TRUST_PROXY` is the number of proxy hops to trust when Orchard finds the client IP address. The default is `1`, for a single ingress in front of the API. A value that is too high lets a client spoof its IP address with a header, which weakens per-IP rate limits. For more information, refer to [Request headers](/deploy/networking/#request-headers).

## 5. Back up the control-plane database

The control-plane database holds every organization, project, app definition, environment variable and audit record. Backups are off by default. Tenant [database backups](/data/backups/) do not include it.

:::caution
Archiving write-ahead logs (WAL) is not a backup. A restore replays WAL onto a base backup. Without a base backup, archived WAL restores nothing.
:::

Use S3-compatible storage on another machine. The installer's local object store is on the same disk as the database, so it does not protect you if the machine is lost.

1. Create a bucket, and a key that can read, write and delete in it.
2. Add the key to the namespace that Orchard runs in. The chart reads the names `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY`.

   ```bash
   kubectl -n orchard create secret generic orchard-db-backup \
     --from-literal=ACCESS_KEY_ID=<KEY_ID> \
     --from-literal=ACCESS_SECRET_KEY=<SECRET>
   ```

3. Set the chart values. On an installer host, run the following commands:

   ```bash
   sudo orchardctl config set postgres.backup.destinationPath s3://my-bucket/orchard-db
   sudo orchardctl config set postgres.backup.endpointURL https://s3.example.com
   sudo orchardctl config set postgres.backup.enabled true --apply
   ```

   On a Helm install, add the following to your values file:

   ```yaml
   postgres:
     backup:
       enabled: true
       destinationPath: s3://my-bucket/orchard-db
       endpointURL: https://s3.example.com # leave out for AWS S3
       secretName: orchard-db-backup # the default
       retentionPolicy: 30d # the default
       schedule: '0 30 1 * * *' # the default, six fields, with seconds
   ```

4. Check that the first base backup finished and that WAL is arriving. The first backup starts when the `ScheduledBackup` exists.

   ```bash
   kubectl -n orchard get backups.postgresql.cnpg.io
   kubectl -n orchard get clusters.postgresql.cnpg.io orchard-db \
     -o jsonpath='{.status.firstRecoverabilityPoint}{"\n"}{.status.conditions[?(@.type=="ContinuousArchiving")].status}{"\n"}'
   ```

5. Test a restore. Create a scratch namespace, copy the Secret into it, then apply the following cluster and check the data:

   ```yaml
   apiVersion: postgresql.cnpg.io/v1
   kind: Cluster
   metadata:
     name: orchard-db-restore
     namespace: orchard-restore-test
   spec:
     instances: 1
     storage:
       size: 10Gi
     bootstrap:
       recovery:
         source: orchard-db
     externalClusters:
       - name: orchard-db
         barmanObjectStore:
           serverName: orchard-db
           destinationPath: s3://my-bucket/orchard-db
           endpointURL: https://s3.example.com
           s3Credentials:
             accessKeyId:
               name: orchard-db-backup
               key: ACCESS_KEY_ID
             secretAccessKey:
               name: orchard-db-backup
               key: ACCESS_SECRET_KEY
   ```

If the barman cloud plugin is already installed in the cluster, you can set `postgres.backup.method` to `plugin`. The restore example applies to the default method.

## 6. Configure object storage for tenant backups

Managed databases need a backup bucket. An installer host uses a local object store by default. The store is on the same disk as the databases, so it does not protect you if the machine is lost.

To use S3 or R2, go to **Instance admin** > **Configuration** > **Object storage**. An organization can also set its own bucket at **Settings** > **Backups**. For more information, refer to [Configure database backups](/operate/finishing-setup/#configure-database-backups).

## 7. Choose your isolation settings

If anyone other than you can deploy, read [Security and isolation](/operate/security/). Network isolation is on by default. Kernel isolation is off. To run untrusted code, install gVisor and Kata, and turn on `tenantSandbox` and `builderSandbox`.

## 8. Set quotas

Set organization caps and member allowances before people start to deploy. For more information, refer to [Set quotas](/teams/quotas/).

## 9. Set up email

Set `SMTP_*` so that sign-in codes, invitations and notifications arrive. For more information, refer to [Set up email](/operate/finishing-setup/#set-up-email).

Without email, Orchard hides email codes and a new member can only sign in through an identity provider. For an existing account, an operator can run `sudo orchardctl login --email <ADDRESS>` to print a one-time link.

## 10. Use a wildcard certificate

The installer issues a certificate for each hostname over HTTP-01, so each new app waits for an ACME request. A wildcard certificate needs a DNS-01 issuer. For more information, refer to [Set up wildcard certificates](/operate/wildcard-certificates/).

## 11. Move to more than one machine

The one-command installer uses one machine, so that machine is a single point of failure. For higher availability, use the Helm chart on a multi-node cluster and use [node pools](/operate/nodes/) to place workloads.

## 12. Pin your version

Automatic nightly updates can change a production instance when you do not expect it. Pin the chart version and upgrade when you decide to.

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version <VERSION> -n orchard -f my-values.yaml
```

## Verify the configuration

Run the following commands:

```bash
kubectl -n orchard exec deploy/server -- printenv SIGNUP_MODE
kubectl get runtimeclass
```

The first command should print `invite_only` or `closed`. If the second command prints nothing and other people can deploy, return to [Security and isolation](/operate/security/).

## Related resources

- [Finish instance setup](/operate/finishing-setup/)
- [Upgrade Orchard](/operate/upgrades/)
- [Back up and restore a database](/data/backups/)
