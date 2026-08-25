---
title: API tokens
description: Credentials for scripts, CI, and anything that is not a browser.
sidebar:
  order: 3
---

A personal access token authenticates as you, without a browser. Use one for
scripts, CI jobs, and tools that call the API directly.

## Creating one

Create a token in user settings. **The value is shown once.** Copy it then;
Orchard stores a hash and cannot show it to you again. If you lose it, delete it
and make another.

## Using one

```bash
curl -H "Authorization: Bearer $ORCHARD_TOKEN" \
  https://your-orchard/apiv1/deployments
```

The [CLI](/cli/) manages its own credential through `orchard auth login`, so you
do not need a token for interactive use. Tokens are for the unattended cases.

## Scope

A token carries **your** permissions. It can do what you can do, in the
organizations you belong to. It is not a service account and does not survive
your access being removed, which is usually what you want: when someone leaves,
their tokens stop working with them.

## Revoking

Delete the token. Anything using it fails immediately.

Rotate by creating the new token, updating the consumer, then deleting the old
one, in that order.

## Related credentials

| Credential                      | For                                              |
| ------------------------------- | ------------------------------------------------ |
| Personal access token           | Scripts and CI acting as you                     |
| [Webhook token](/run/webhooks/) | Triggering one app's deploy                      |
| SCIM token                      | Your identity provider, see [SCIM](/teams/scim/) |
| MCP connection                  | Agents, see [MCP](/mcp/)                         |

Keep them in a secret store, not in a repository. A token in a public repo is a
token someone else has.
