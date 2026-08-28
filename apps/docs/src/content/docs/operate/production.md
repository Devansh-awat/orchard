---
title: Going to production
description: Turning a trial instance into one you would put real work on.
sidebar:
  order: 5
---

The one-command installer optimises for getting you running, not for running in
production. Everything below is the gap between those two.

Work through it in order. Each item says what breaks if you skip it.

## 1. Secrets

The installer generates secrets, but an instance assembled by hand may still be
carrying defaults.

| Variable                 | Why                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `JWT_SECRET`             | Signs sessions. A known value means anyone can mint a session.     |
| `SECRETS_ENCRYPTION_KEY` | Encrypts stored environment secrets. Required to save them at all. |

`JWT_SECRET` must not be the example string. Both belong in a Kubernetes secret,
not in a values file in a repository.

**Rotating `SECRETS_ENCRYPTION_KEY` makes existing stored secrets
unreadable.** Set it once, before people start storing things.

## 2. Close signups

The default for a fresh chart install is `invite_only`. The installer may set
`open` so you can create the first account.

```yaml
signupMode: invite_only # or: closed
```

`open` on a public URL means anyone who finds it can create an account and start
running workloads on your hardware.

## 3. Claim superadmin, then check it

A fresh install mints a single-use setup token, valid 24 hours. Redeem it with
the account that should own the instance. See
[Install](/start/install/#claiming-the-instance).

Afterwards, confirm there is exactly one superadmin and it is you.

## 4. Sit behind TLS properly

```bash
SESSION_COOKIE_SECURE=true
TRUST_PROXY=1
```

`SESSION_COOKIE_SECURE=true` stops session cookies being sent over plain HTTP.

`TRUST_PROXY` tells the server how many proxy hops to believe when working out
the client IP. It defaults to `1`, which is right for a single ingress in front
of the API. Set it too high and a client can spoof its own IP by sending a
header, which quietly breaks per-IP rate limiting. See
[request headers](/deploy/networking/#request-headers).

## 5. Back up the control-plane database

This is the one people skip.

The control-plane Postgres holds every organization, project, app definition,
environment variable and audit record on the instance. Tenant databases have
their own [backups](/data/backups/); the control-plane database does not get
them for free.

:::danger
Archiving write-ahead logs is not a backup. WAL replays **onto a base backup**;
with no base backup, archived WAL restores nothing.

Take a base backup, then restore it somewhere and confirm it works. An untested
backup is a hypothesis.
:::

## 6. Configure object storage for tenant backups

Database backups need somewhere to go: an S3-compatible endpoint, bucket and
credentials, configured per organization. Without it, the backup UI exists and
produces nothing.

## 7. Decide your isolation posture

If anyone other than you can deploy, read
[Security and isolation](/operate/security/) and decide deliberately.

The short version: network isolation is on by default, kernel isolation is not.
Running untrusted code safely means installing gVisor and Kata and enabling
`tenantSandbox` and `builderSandbox`.

## 8. Set quotas

Give organizations caps and members allowances before they need them, not after
someone requests 32 cores for a side project. See
[Quotas and usage](/teams/quotas/).

## 9. Email

Set `SMTP_*` so sign-in codes, invitations and notifications actually arrive.
Without SMTP, one-time codes have nowhere to go and nobody can sign in except
through SSO.

## 10. Wildcard certificates

The installer issues per-hostname certificates over HTTP-01. That works, but
every new app waits on an ACME round-trip.

A wildcard certificate needs a DNS-01 issuer, which is a chart-level change. See
`SETUP-wildcards.md` in the chart.

## 11. Move off a single box

The one-command installer is one machine. One machine means the node is a single
point of failure and upgrades are downtime.

For real availability, use the Helm chart on a multi-node cluster and let
[node pools](/operate/nodes/) place workloads deliberately.

## 12. Pin your version

```bash
helm upgrade orchard oci://ghcr.io/hackclub/orchard/charts/orchard \
  --version <pinned> -n orchard -f my-values.yaml
```

Automatic nightly updates are convenient for a homelab and surprising in
production. Pin the chart version and upgrade when you decide to.

## Quick audit

```bash
# Signup mode and superadmins
kubectl -n orchard exec deploy/server -- printenv SIGNUP_MODE

# Sandbox runtimes present?
kubectl get runtimeclass

# Is anything still on a default secret?
kubectl -n orchard get secret -o name
```

If `kubectl get runtimeclass` is empty and people other than you can deploy,
start at [Security and isolation](/operate/security/).
