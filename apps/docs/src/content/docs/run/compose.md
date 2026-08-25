---
title: Compose stacks
description: Bring a docker-compose file and get several services at once.
sidebar:
  order: 3
---

A compose stack takes a `docker-compose.yml` and creates the services in it as
apps in a project, wired together, rather than making you click through each one.

It is the fastest way to move something that already runs under Docker Compose
onto a cluster.

## What translates

Services, images, ports, environment variables, and simple dependencies map
cleanly onto apps.

## What does not

Compose assumes one host. Some of it has no Kubernetes equivalent and is either
adapted or ignored:

- **Bind mounts** of host paths, because there is no single host to bind to. Use
  [storage](/deploy/storage/) instead.
- **`network_mode: host`** and container-level networking tricks.
- **`depends_on` as a readiness guarantee.** It controls start order, not
  readiness; on a cluster, services must tolerate their dependencies being
  briefly unavailable.
- **Build contexts** that assume files outside the repository.

Treat the import as a starting point that gets you 80% of the way, then check
each service rather than assuming a clean translation.

## After importing

The stack stays visible as a unit, so you can see what came from it and remove
it together, while each service is a normal app you can scale, redeploy and roll
back on its own.
