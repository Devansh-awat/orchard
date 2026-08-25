---
title: SCIM provisioning
description: Create, update and deactivate accounts from your identity provider.
sidebar:
  order: 3
---

SCIM lets your identity provider push user lifecycle into Orchard: someone joins,
their account appears; someone leaves, their access goes away without anyone
remembering to remove it.

## What it covers

- Creating users
- Updating attributes
- Deactivating users when they are removed upstream
- Group and role mapping, so provider groups map to Orchard roles

## Setting it up

Orchard exposes a SCIM 2.0 endpoint and a token for your provider to
authenticate with. Configure both in the provider's application, then run a test
sync with a single user before enabling the whole directory.

## Notes

**SCIM does not authenticate anyone.** It manages accounts; sign-in is
[SSO](/teams/sso/). Most people want both.

**Deactivation is the point.** Automatic creation saves a few minutes; automatic
deactivation is what stops a former colleague keeping a working login.

**Roles change on sync.** If group mapping is configured, an upstream group change
alters someone's role in Orchard at the next sync, which will override a manual
change made in the dashboard.
