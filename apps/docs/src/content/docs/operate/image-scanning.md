---
title: Image scanning
description: Choosing a vulnerability scanner for the Security tab, turning it on, and what each one covers.
sidebar:
  order: 7
---

Every app has a **Security** tab. Its configuration checks (secrets stored as
plain variables, moving image tags, domains without TLS) always run. The image
scan, the list of known vulnerabilities in the app's container image, needs a
scanner, and **image scanning is off until a superadmin turns it on**.

There are two scanners to choose from:

|                                                  | Harbor                                                  | Orchard scanner                                                           |
| ------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| What it is                                       | Harbor's own scanner (Trivy, run by Harbor)             | A Trivy server Orchard deploys, plus one short-lived scan job per request |
| Needs                                            | Harbor as your registry, with API credentials           | `trivy.enabled: true` in the chart                                        |
| Images built by Orchard                          | Yes                                                     | Yes                                                                       |
| Images from Docker Hub, GHCR or another registry | No                                                      | Yes, including private ones with registry credentials                     |
| Self-hosted installs (zot registry)              | No                                                      | Yes                                                                       |
| When a scan runs                                 | When Harbor scans on push, or when someone presses Scan | When someone presses Scan                                                 |

If your registry is Harbor and it already scans on push, pick Harbor: nothing
new to run. Otherwise, and on every installer-based instance, use the Orchard
scanner.

## Turning it on

### Harbor

1. Make sure the server has Harbor API access: `HARBOR_USERNAME` and
   `HARBOR_PASSWORD` (a robot account with read access to the project is
   enough, plus "scan" if people should be able to press Scan), and
   `DOCKER_REGISTRY_PULL` pointing at Harbor. Set `HARBOR_API_URL` if the API is
   reached at a different address from the registry, for example Harbor's core
   service inside the cluster.
2. Optional: turn on **Automatically scan images on push** in the Harbor project
   so results are there before anyone opens the tab.
3. In **Admin, Instance, Image scanning**, pick **Harbor**.

### Orchard scanner

1. Enable the chart block and roll it out:

   ```yaml
   trivy:
     enabled: true
   ```

   On installer-based instances add it to `/etc/orchard/values.yaml` and run
   `orchard-update`. This creates the `orchard-scans` namespace with the Trivy
   server, and gives the API server the variables it needs (`TRIVY_SERVER_URL`,
   `ORCHARD_INTERNAL_URL` and the rest, listed in the
   [configuration reference](/reference/configuration/)).

2. Wait for the `trivy` pod in `orchard-scans` to become ready. The first start
   downloads the vulnerability database, which takes a minute or two.
3. In **Admin, Instance, Image scanning**, pick **Orchard scanner**.

A scanner whose requirements are missing is greyed out in the admin panel with
the reason, so you cannot pick one that would not work.

### Pinning the choice

Set `IMAGE_SCANNER` to `off`, `harbor` or `trivy` in the server environment to
fix the choice. The admin panel then shows it as an environment override and
cannot change it. Leave it unset to let superadmins decide.

## What happens during a scan

With the Orchard scanner, pressing **Scan** on an app:

1. records the scan and creates a Job in `orchard-scans`, together with a Secret
   holding the registry credentials it needs (Orchard's own registry, plus any
   registry credentials saved on the project) and a one-time token;
2. the Job runs Trivy in client mode: it pulls the image layers itself and asks
   the Trivy server which packages have known vulnerabilities;
3. the Job posts the report back to the API server, which keeps the worst 500
   findings and the totals;
4. the Job and its Secret are deleted 10 minutes after it finishes.

A scan that fails, runs out of time (15 minutes by default) or whose Job is
deleted shows up as **The last scan failed** with Trivy's error, for example an
authorization failure pulling a private image. At most three scans run at once;
a fourth is refused with a message to try again shortly.

The result belongs to the image, not the app, so two apps running the same
image share it. A result is not refreshed on its own: the vulnerability
database changes daily, so press **Scan again** to recheck an image that has not
been rebuilt.

## What app teams see

Anyone who can view an app sees its scan result. Members who can edit it can
start a scan. When scanning is off the tab says **Image scanning is off** and
still shows the configuration checks.

## Security notes

- Scan jobs run with no service account token, as a non-root user, with a
  read-only root filesystem, under Pod Security `restricted`. They take no
  inbound traffic and cannot reach cloud metadata (`169.254.0.0/16`).
- Trivy reads image layers but never runs them.
- Only scan jobs may talk to the Trivy server, and they authenticate with a
  shared token kept in the `trivy-server-token` Secret.
- The result endpoint is `POST /apiv1/internal/image-scans/:id/result`. It
  accepts one report per scan, authenticated by that scan's one-time token, and
  nothing once the scan has finished.
- If your registry or the Orchard namespace has a NetworkPolicy of its own,
  allow traffic from `orchard-scans`.
