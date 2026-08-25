---
title: Domains and HTTPS
description: The free URL every app gets, and pointing your own domain at one.
sidebar:
  order: 4
---

## The free URL

Every app can generate a URL on the instance's app domain the moment it deploys,
with HTTPS already working. Uncheck **Generate a URL** for workers and anything
without an HTTP surface.

## Your own domain

Add a domain on the app's **Network** tab and Orchard tells you the record to
create. Point it at the instance's ingress target (a CNAME on most setups), then
validate.

Orchard checks the DNS itself before issuing anything, so a typo fails with "the
record does not resolve here" instead of a certificate that silently never
arrives. Once the record resolves, cert-manager issues the certificate and
renews it without being asked.

Organizations can have **DNS-verified domains**, which proves ownership of a
parent domain once so hostnames underneath it can be attached without
re-verifying each time.

## Certificates

On the one-command installer, apps get per-hostname certificates over HTTP-01.
Wildcards need a DNS-01 issuer, which is a chart-level setting rather than
something a tenant configures.

In Cloudflare Tunnel mode, Cloudflare terminates TLS and cert-manager is skipped
entirely.

## Ports and the internal address

An app can expose more than one port, TCP or UDP. Each port shows its **internal
cluster address** underneath, which is what other apps in the same namespace
should talk to. Use the internal address for service-to-service traffic: it stays
inside the cluster, skips the ingress, and does not depend on public DNS.

Publicly exposing a raw TCP or UDP port needs an L4 load balancer, and is not
available in tunnel mode because Cloudflare Tunnels carry HTTP only.
