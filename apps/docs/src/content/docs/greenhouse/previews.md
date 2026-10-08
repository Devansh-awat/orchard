---
title: Previews and ports
description: Open the dev server a session is running, and deploy a session as an Orchard preview environment.
sidebar:
  order: 7
---

There are two ways to look at what a session built:

- **A preview** opens the dev server running on the machine, live, as you and the
  agent change code. Nothing is built or deployed.
- **A preview environment** builds the session's branch and deploys it to an
  Orchard project like any other app, with its own URL, so people without access
  to the machine can try it.

## Ports

The dock's **Ports** tab lists every TCP port a process on the machine is
listening on, refreshed while the tab is open. Each row shows:

- the port and the process listening on it;
- whether the process was started from this session's worktree;
- whether it listens on `localhost` only, which a preview cannot reach;
- **Public**, on Vercel machines, where ports are reachable from the internet.

The machine's own services (SSH on 22, the SSH bridge on 2222 and the agent server
on 4096) are left out.

## Open a preview

Click **Open preview** on a port. Previews work on these ports:

```
3000  3001  4173  5173  8000  8080  8787
```

Start your dev server on one of them, bound to `0.0.0.0`. A
[run script](/greenhouse/scripts/) is the easiest way to keep that consistent.

Anyone who can see the machine can open its previews: the host, guests and
read-only guests.

### On Kubernetes machines

The preview opens at its own address:

```
https://<port>-<machine>.<preview domain>/
```

where `<machine>` is the first eight characters of the machine's id and the
preview domain is set by your operator. The address is private:

- **Open preview** gives you a link with a single-use ticket that expires after
  60 seconds. Opening it sets a cookie for that preview address only, valid for
  12 hours, and drops the ticket from the URL.
- Every request after that is checked against your current access, so removing
  someone from a machine also cuts off their previews within seconds.
- Your Orchard session cookie is never sent to the preview, and the preview cannot
  set cookies for Orchard. The preview domain is deliberately separate from the
  domain Orchard runs on.
- Requests from other sites are refused, so a page elsewhere cannot drive your
  preview with your cookie.

HTTP and WebSockets both work, so hot reload does too.

If a link says it has expired, open it again from Greenhouse. If it says nothing
is answering, the dev server is not listening on that port (or is listening on
`localhost` only).

### On Vercel machines

The preview is the machine's public URL for that port on Vercel's domain. It needs
no ticket and works for **anyone who has the link**, signed in or not. Do not run
anything on a preview port of a Vercel machine that you would not put on the
public internet.

## Deploy a session as a preview environment

**Deploy preview**, in the session menu or the pull request menu, ships the
session's branch to a project on this Orchard instance.

What it does:

1. Pushes the session branch to GitHub.
2. Creates an environment named `gh-<slug>` in the project you pick, or reuses the
   one this session already has.
3. Copies the configuration of a deployment in that project that builds the same
   GitHub repository: build settings, ports, volumes, resources and environment
   variables. It prefers a deployment in the project's default environment, then
   its production one. Pick a specific deployment to copy instead if there are
   several.
4. Deploys the branch there, with one replica, and gives it a URL.

The session row then shows the preview's status (**building**, **deploying**,
**ready**, **failed**, **stopped**) and its URL, which Orchard computes like every
other app URL.

Variables that reference another resource in the source environment (for example
a database's connection string) are left out, because that resource does not
exist in the new environment. The response lists them so you can set them on the
preview by hand.

Deploying again redeploys the latest commit to the same environment.

### Teardown

The preview environment belongs to the session:

- **Remove preview** deletes it.
- **Archiving** or **deleting** the session deletes it automatically.

Only environments Orchard created for a session (`gh-` environments that are not
the default or production environment) are ever deleted this way.

### Who can deploy

Deploying and removing previews is **host only**, and the host also needs edit
access to the target project. The project must belong to the machine's
organization.

From the CLI:

```bash
orchard sandbox session preview leafy fix-login --project storefront
orchard sandbox session preview leafy fix-login --deployment <deployment-id>
orchard sandbox session preview leafy fix-login --remove
```
