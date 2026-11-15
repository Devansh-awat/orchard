---
title: FAQ
description: Answers to common questions about Orchard, including production use, adding servers, running untrusted code, databases, telemetry, and licensing.
sidebar:
  order: 5
---

## Should I use the one-command installer for production?

No. The installer builds a single-node k3s cluster, so that one machine is a single point of failure. It suits a home lab, a side project, a small team, or a trial. For production, Orchard recommends the [Helm chart](/start/install/#install-on-an-existing-cluster) on a multi-node cluster. For the differences, refer to [Choose a layout](/operate/production/#choose-a-layout).

Whichever setup you choose, work through [Go to production](/operate/production/) before you go live.

## Can I add more servers to my instance?

Yes, if you installed Orchard with the Helm chart. Join the node with your distribution's tools, then sync nodes in **Instance admin**.

Not yet, if you used the one-command installer. An installer host is single-node, and support for adding nodes is planned for a later release. If you need more than one node, use the Helm chart. For both cases, refer to [Add and remove nodes](/operate/nodes/#add-and-remove-nodes).

## Is it safe to let people I do not trust deploy code?

No, not with the default settings. Apps cannot reach each other over the network, but they share the host kernel, and image builds run on it too. A kernel vulnerability in one app could affect every app on the node.

Before you open an instance to people you do not trust, install gVisor and Kata, turn on `tenantSandbox` and `builderSandbox`, and follow [Requirements for untrusted code](/operate/security/#requirements-for-untrusted-code).

## Do I need to know Kubernetes?

No. The installer sets up k3s and every component that Orchard needs, and you deploy from the dashboard, the CLI, or an agent. Orchard does use some Kubernetes words where they matter, such as pods, replicas, and namespaces.

To install Orchard with the Helm chart, you do need to operate the cluster yourself. For the list of components the chart expects, refer to [Install on an existing cluster](/start/install/#install-on-an-existing-cluster).

## Can I run databases other than Postgres?

Yes, but Orchard manages only Postgres. A [managed database](/data/databases/) runs on CloudNativePG, with backups, point-in-time restore, failover, and read replicas. You can run other databases, such as MariaDB or MongoDB, as apps with a volume from [templates](/run/templates/). Orchard does not give those databases managed backups or point-in-time restore.

## Is there a hosted version of Orchard?

No. Orchard is self-hosted only. You run the instance on your own server or cluster. To start, refer to [Install](/start/install/).

## Does Orchard send data about my instance?

No, not unless you opt in. Anonymous usage reports are off until a superadmin turns them on, or an operator sets `ORCHARD_TELEMETRY` to `true`. For exactly what a report contains, refer to [Manage anonymous usage reports](/operate/telemetry/). For every host that an instance contacts, refer to [Outbound connections](/operate/outbound-connections/).

## How does Orchard compare to Coolify, Dokku, and similar tools?

Coolify, Dokploy, and CapRover run apps as Docker containers and manage them from a web dashboard. Dokku gives you git-push deploys on a Docker host. Orchard runs on Kubernetes, with k3s set up for you by the installer. Because of this, apps get default-deny network isolation on a network plugin (CNI) that enforces NetworkPolicy, managed Postgres runs on CloudNativePG with point-in-time restore, builds run in rootless BuildKit, and the Helm chart can run Orchard on a multi-node cluster. The cost is weight: the cluster, the operators, and the metrics and logs stack use memory before your first app runs. Orchard runs on 2 GiB of RAM, and 8 GiB is recommended.

For a feature-by-feature table with sources, refer to [Compare](https://orchard.hackclub.com/compare).

## What license is Orchard under?

Orchard is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). The SDK for building grafts, which are Orchard extensions, is `@orchardlabs/graft-sdk` and is licensed under MIT. The graft UI kit, `@orchardlabs/graft-ui`, is licensed under AGPL-3.0, like the rest of Orchard. If other people use a modified version of Orchard over a network, the AGPL requires you to offer them its source code. For details, refer to [Licenses](/operate/licenses/).

## Can I replace components such as the registry?

Yes. On any install, you can send backups to your own S3-compatible storage instead of the store on the server. Refer to [Add S3 storage](/operate/storage/).

With the Helm chart, you choose the rest. You can use Harbor or another OCI registry instead of zot, a replicated StorageClass instead of `local-path`, any ingress controller for app URLs (request metrics and request logs need Traefik or HAProxy), and an external Redis with `redis.url`. Refer to [Turn on image builds](/start/install/#turn-on-image-builds) and [Use your own registry](/operate/finishing-setup/#use-your-own-registry).
