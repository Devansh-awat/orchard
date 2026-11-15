---
title: Rate limits and client addresses
description: Configure how Orchard finds the real client address behind proxies, so that sign-in rate limits apply to each visitor.
sidebar:
  order: 3
---

Orchard limits sign-in attempts per client address, which slows down scripts that request or guess sign-in codes. The limits only work when two things are true: every server pod shares the same counters, and the address Orchard sees belongs to the visitor, not to a proxy in front of it. This page shows how to get both right for your setup.

## Share the counters

Set `REDIS_URL` on the server, so that one limit covers the whole instance. Without Redis, some counters are held per pod, and those limits multiply by the number of replicas. The server logs this when it starts:

```txt
REDIS_URL not set: attempt counters are per-pod, so every limit multiplies by replica count
```

## Find the client address

Orchard starts at the address of the connection and walks `X-Forwarded-For` from the right, skipping the proxy hops you configured. The first address after those hops is the client. Orchard does not read `X-Real-IP`, and it does not treat an address as a proxy because the address is private.

| Variable                | Chart value                   | Effect                                                                                                                                                                             |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`           | `clientIp.trustProxy`         | The number of hops to trust, such as `1` for one ingress or `2` for a load balancer and an ingress, or a list of CIDRs. Unset trusts nothing. The chart and the installer set `1`. |
| `TRUSTED_PROXY_RANGES`  | `clientIp.trustedProxyRanges` | Extra proxy CIDRs, trusted at any position.                                                                                                                                        |
| `TRUST_CLOUDFLARE`      | `clientIp.trustCloudflare`    | Set `false` to stop skipping Cloudflare's published address ranges.                                                                                                                |
| `CLIENT_IP_HEADER`      | `clientIp.header`             | A header that carries the client address, such as `cf-connecting-ip`.                                                                                                              |
| `CLIENT_IP_HEADER_FROM` | `clientIp.headerFrom`         | The CIDRs of the hop that may supply that header. Without a match, Orchard ignores the header.                                                                                     |

## Choose the settings for your setup

| Setup                                       | Settings                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traefik or HAProxy directly on the internet | `TRUST_PROXY=1`.                                                                                                                                                                                                      |
| Cloudflare proxy in front of the ingress    | `TRUST_PROXY=1`. Orchard skips Cloudflare's ranges.                                                                                                                                                                   |
| Cloudflare Tunnel, from the installer       | The installer sets `TRUST_PROXY=1`, `CLIENT_IP_HEADER=cf-connecting-ip`, and `CLIENT_IP_HEADER_FROM`, and adds a NetworkPolicy so that only the `cloudflared` and `orchard` namespaces can reach Traefik's web ports. |
| Your own Cloudflare Tunnel                  | Use the same settings, and apply an equivalent NetworkPolicy before you set them.                                                                                                                                     |
| A LAN install                               | `TRUST_PROXY=1`.                                                                                                                                                                                                      |

If you put a CDN in front of Orchard, allow only the CDN's address ranges to reach the origin.

To check the result, run the `client-ip-trust` check in [Check isolation](/operate/doctor/#client-ip-trust).

## A load balancer that hides client addresses

If your load balancer uses source NAT, every visitor arrives with the balancer's address and shares one limit. Set `externalTrafficPolicy: Local` on the Service, or use the proxy protocol.

## Related resources

- [Go to production](/operate/production/) - Prepare an instance for real users.
- [Turn on bot protection](/operate/bot-protection/) - Add a Turnstile challenge to the sign-in pages.
- [Scale the control plane](/operate/scale-control-plane/) - Run more than one server pod.
