---
title: Networking
description: Ports, service-to-service traffic, internal DNS, and exposing things publicly.
sidebar:
  order: 4
---

Every app gets a Kubernetes Service in front of its pods. That Service is what
load-balances across replicas and what other apps talk to.

## Ports

An app declares the ports its process listens on **inside the container**. This
is not the port anyone connects to from outside; it is what the process binds.

Each port is TCP or UDP, and each can be exposed or kept internal.

## Talking to another app

Under every port, Orchard shows the **internal cluster address**. That is what
other apps in the same namespace should use:

```
http://<app-name>            # same namespace, shortest form
http://<app-name>.<namespace>.svc.cluster.local
```

Use the internal address for service-to-service traffic. It stays inside the
cluster: no trip out to the internet, no ingress hop, no public DNS dependency,
and no TLS termination in the middle.

Reaching another app through its public URL works, but every request leaves the
cluster and comes back. It is slower, it breaks if public DNS is having a bad
day, and it puts internal traffic through your ingress for no reason.

Short names resolve within a namespace, which is why a job in the same project
can `curl http://site/` and get the app.

## Public HTTP

Generating a URL, or attaching a custom domain, creates a route from the
ingress to the Service. See [Domains and HTTPS](/deploy/domains/).

Put an auth wall in front with [protection](/deploy/protection/) if the app
should not be open to the world.

## Public TCP and UDP

Raw ports can be published, which is how you reach a database or a game server
from outside. This needs an L4 load balancer in the cluster, and it is
unavailable in Cloudflare Tunnel mode because tunnels carry HTTP only.

Public TCP and UDP bypass the HTTP layer entirely, so protection does not apply
to them. Anything published this way needs its own authentication.

## Databases

Managed databases are reachable in-cluster by default and are the main consumer
of internal addresses. Public exposure assigns a port on the organization's
shared database IP. See [Databases](/data/databases/#public-access).

## Egress

Apps can reach the internet outbound. Sandboxes are more restricted: they get
internet egress only, and cannot reach other workloads in the cluster.

## Request headers

Traffic reaches your app through at least one proxy, so the socket peer is the
proxy, not the visitor. The original client details arrive in headers.

| Header              | Set by                        | Contains                               |
| ------------------- | ----------------------------- | -------------------------------------- |
| `X-Real-IP`         | The ingress                   | The peer of the inbound TCP connection |
| `X-Forwarded-For`   | The ingress, appended per hop | The client chain, left to right        |
| `X-Forwarded-Proto` | The ingress                   | `https` or `http` as the client saw it |
| `X-Forwarded-Host`  | The proxy                     | The hostname the client requested      |

**Prefer `X-Real-IP` for the client address.** The ingress sets it to the actual
peer and overwrites anything the client tried to supply, which makes it the one
value that cannot be spoofed from outside. `X-Forwarded-For` is a list that
anyone can prepend to; only trust the entries your own proxies added.

If your framework derives the client IP from `X-Forwarded-For`, tell it how many
proxy hops to trust rather than trusting the whole chain. Getting this wrong is
how rate limiting by IP becomes rate limiting by whatever the attacker typed.

Behind [protection](/deploy/protection/) there is an extra hop: the wall proxies
to your app and forwards these headers on, appending the peer it saw.

Apps sitting behind a protected domain never see the internal bypass header the
platform uses between its own components; it is stripped before the request
reaches you.

### If your app generates links

Use `X-Forwarded-Proto` and `X-Forwarded-Host` when building absolute URLs.
Otherwise a framework will happily generate `http://10.244.2.7:3000/...` because
that is what the socket says, and email links will point at a pod IP.
