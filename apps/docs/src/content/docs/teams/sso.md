---
title: SSO
description: SAML and OIDC sign-in, configured per organization.
sidebar:
  order: 2
---

Orchard supports **SAML** and **OIDC**, and an organization can configure more
than one provider.

**SSO is off by default.** It is enabled deliberately, per organization, by an
admin of that organization.

## Per-organization login

An organization with SSO configured gets its **own login page**, so members go
straight to their provider instead of picking from a list of every provider on
the instance.

Sessions created through SSO are **scoped to the tenant** they signed in for.
An SSO session for one organization is not a session for another.

## Verified domains

An organization can verify a domain it owns through DNS. Verification proves
ownership once, which is what lets an organization claim its email domain for
sign-in rather than anyone being able to assert it.

## Setting it up

1. Verify your domain.
2. Add the provider (SAML metadata, or OIDC issuer, client ID and secret).
3. Set the callback URL your provider needs, shown during setup.
4. Test with one account before enabling it for everyone.

Keep one non-SSO admin account until you have signed in successfully. A
misconfigured provider with no way around it locks the organization out of its
own instance.

## Provisioning

SSO handles authentication. For creating and deactivating accounts automatically,
see [SCIM](/teams/scim/).
