---
title: Set up image scanning
description: Choose a vulnerability scanner for the Orchard Security tab, turn it on, and review how each scanner works.
sidebar:
  order: 7
---

To show known vulnerabilities in an app's container image on its **Security** tab, set up a scanner. The tab also has configuration checks, such as secrets stored as plain variables, moving image tags, and domains without TLS. Those checks always run.

## Choose a scanner

|                                                  | Harbor                                                  | Orchard scanner                                                           |
| ------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| What it is                                       | Harbor's own scanner (Trivy, run by Harbor)             | A Trivy server that Orchard deploys, plus one short-lived scan job for each request |
| Needs                                            | Harbor as your registry, with API credentials           | `trivy.enabled: true` in the chart                                        |
| Images built by Orchard                          | Yes                                                     | Yes                                                                       |
| Images from Docker Hub, GHCR, or another registry | No                                                      | Yes, including private images with registry credentials                   |
| Installer hosts (zot registry)                   | No                                                      | Yes                                                                       |
| When a scan runs                                 | When Harbor scans on push, or when someone selects **Scan now** or **Scan again** | When someone selects **Scan now** or **Scan again** |

If your registry is Harbor and it already scans on push, use Harbor. Otherwise, use the Orchard scanner.

## The default scanner

Until a superadmin chooses a scanner, Orchard uses the first match:

1. **The Orchard scanner**, if `TRIVY_SERVER_URL` and `ORCHARD_INTERNAL_URL` are set and Kubernetes is reachable.
2. **Harbor**, if the registry is Harbor. Orchard checks `/api/v2.0/systeminfo` on the Harbor API. It caches the answer for ten minutes, or one minute after a network error.
3. **Off**.

The one-command installer sets `trivy.enabled: true`. `orchardctl update` turns it on for a host installed before this default existed.

To choose a scanner, go to **Instance admin** > **Configuration** > **Image scanning**. The stored choice replaces the default, including a choice of **Off**. A scanner with missing requirements is unavailable, and the page shows the reason.

## Set up the Orchard scanner

Installer hosts already have the Orchard scanner.

1. Turn on the chart block. On an installer host, run the following command:

   ```bash
   sudo orchardctl config set trivy.enabled true --apply
   ```

   On a Helm install, add the following to your values file and run `helm upgrade`:

   ```yaml
   trivy:
     enabled: true
   ```

   This creates the `orchard-scans` namespace with the Trivy server, and sets the variables that the server needs.

2. Wait for the `trivy` pod in `orchard-scans` to become ready. The first start downloads the vulnerability database.
3. If a superadmin already chose another scanner, go to **Instance admin** > **Configuration** > **Image scanning** and select **Orchard scanner**.

Scan jobs pull images from `DOCKER_REGISTRY_PUSH` with `HARBOR_USERNAME` and `HARBOR_PASSWORD`. They use plain HTTP when the host is in `REGISTRY_HTTP_HOSTS`.

If your registry or the Orchard namespace has its own NetworkPolicy, allow traffic from `orchard-scans`.

To turn off the scanner on an installer host, run the following command. `orchardctl update` does not turn it back on.

```bash
sudo orchardctl config set trivy.enabled false --apply
```

## Set up Harbor

1. Give the server Harbor API access. Set `HARBOR_USERNAME` and `HARBOR_PASSWORD`, and set `DOCKER_REGISTRY_PULL` to Harbor. A robot account with read access to the project is enough. Add the scan permission if people should start scans from Orchard.
2. If the API is at a different address from the registry, set `HARBOR_API_URL`.
3. (Optional) Turn on **Automatically scan images on push** in the Harbor project.
4. Go to **Instance admin** > **Configuration** > **Image scanning**.
5. Select **Harbor**.

## Pin the scanner

To fix the choice for the instance, set `IMAGE_SCANNER` on the server to `off`, `harbor`, or `trivy`. This value overrides the stored choice and the default. The **Image scanning** section shows it as an environment override.

```bash
sudo orchardctl env set IMAGE_SCANNER off --apply
```

## How a scan works

With the Orchard scanner, a scan runs as follows:

1. Orchard records the scan and creates a Job in `orchard-scans`, with a Secret that holds the registry credentials and a one-time token.
2. The Job waits up to about a minute for the Trivy server to answer. On clusters that take a few seconds to apply NetworkPolicy to a new pod, such as k3s, the first connection is refused.
3. The Job runs Trivy in client mode. It pulls the image layers and asks the Trivy server which packages have known vulnerabilities.
4. The Job posts the report to the API server. The server keeps the worst 500 findings and the totals.
5. Kubernetes deletes the Job and its Secret 10 minutes after it finishes.

The tab shows **The last scan failed** with the reason when a scan fails, times out, or loses its Job. If the Job never reaches the Trivy server, the reason is **Could not reach the Trivy server**. Check that the `trivy` pod in `orchard-scans` is ready. The default timeout is 15 minutes.

At most `trivy.maxConcurrentScans` scans run at once. The value is `3` in the chart and `2` from the installer, or `1` on a machine with less than 8 GB of memory. Orchard refuses more requests until a scan finishes.

A result belongs to the image, so two apps that run the same image share it. Results do not refresh on their own. To check an image that has not been rebuilt, select **Scan again**.

## Permissions

Anyone who can view an app can see its scan result. Members who can edit the app can start a scan. When scanning is off, the tab shows **Image scanning is off** and still runs the configuration checks.

## Security of scan jobs

- Scan jobs run with no service account token, as a non-root user, with a read-only root filesystem, under Pod Security `restricted`.
- Scan jobs take no inbound traffic and cannot reach cloud metadata at `169.254.0.0/16`.
- Trivy reads image layers but does not run them.
- Only scan jobs can reach the Trivy server. They authenticate with a shared token in the `trivy-server-token` Secret.
- The result endpoint is `POST /apiv1/internal/image-scans/:id/result`. It accepts one report for each scan, authenticated by that scan's one-time token.

## Related resources

- [Configure logs and request data](/operate/logs/)
- [Configuration](/reference/configuration/)
