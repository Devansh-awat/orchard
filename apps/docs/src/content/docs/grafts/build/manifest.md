---
title: graft.json
description: Every field of a graft's manifest, and how claims work.
sidebar:
  order: 2
---

`graft.json` is what Orchard reads before it runs any of a graft's code. Unknown
fields are refused, so a typo fails loudly at `graft pack`.

```json
{
  "id": "announcements",
  "name": "Announcements",
  "version": "0.2.0",
  "publisher": "orchard",
  "description": "Post instance-wide notices that show up on every project and app page.",
  "engines": { "platform": ">=2.67.0 <3", "sdk": "^1.0.0" },
  "capabilities": ["db", "audit", "settings"],
  "database": { "coreReads": { "users": ["id", "username"] } },
  "settings": [
    {
      "id": "display",
      "title": "Announcements",
      "fields": [{ "key": "maxShown", "type": "number", "label": "Shown on overview pages" }]
    }
  ],
  "ui": { "screens": [{ "id": "manage", "path": "/announcements", "layout": "shell" }] }
}
```

| Field | Means |
| --- | --- |
| `id` | 2 to 48 lowercase letters, digits and dashes, starting with a letter. Names in Orchard such as `admin` or `api` are reserved. It is the graft's URL prefix and namespace |
| `name`, `version`, `publisher`, `description`, `homepage`, `icon` | Shown in the Extension Marketplace and on Admin → Grafts. `version` is semver |
| `engines.platform` | Orchard versions the graft works with, as a semver range |
| `engines.sdk` | Graft SDK versions it was built against |
| `uses` | Filled in by `graft pack`: the doors and versions the server code injects |
| `requires.grafts` | Other grafts it needs, with version ranges |
| `requires.kubernetes.crds` | CRDs that must exist. `orchardctl` checks before installing |
| `capabilities` | What the graft asks for. Each door needs its capability; see the [graft API reference](/reference/graft-api/) |
| `database.coreReads` | Core tables and columns the graft may read, for joins. Shown before install |
| `permissions` | Permissions the graft checks, with default grants by role, e.g. `{ "use": { "label": "Use it", "defaultGrants": ["org:member"] } }` |
| `settings` | Sections for Admin → Configuration. Fields are `string`, `text`, `number`, `boolean`, `select` or `secret`, and can name an `env` variable that overrides them |
| `ui.screens` | Pages the graft owns: `id`, `path` (with `:param` and a trailing `*`), `layout` (`shell` or `fullscreen`), `title` |
| `public.routes` | Every route open to anyone, as `"POST /hooks/github"`. Anything public that is not listed is refused |
| `claims` | Names outside the graft's own id. See below |
| `entries` | Filled in by `graft pack` |

## Claims

A graft owns everything under its id without asking: `/apiv1/<id>/...`,
`/<id>/...`, and names that start with `<id>.`, `<id>-` or `<id>_`. A name
outside that is a claim, listed under `claims` and shown to the admin before
install:

| Claim | For |
| --- | --- |
| `apiAliases` | API paths, e.g. `sandboxes` serves `/apiv1/sandboxes/...` from the graft's own `sandboxes` controller |
| `uiAliases` | Top-level page paths |
| `wsAliases` | Websocket paths |
| `hostRouting` | Hostnames the graft serves directly, for preview domains |
| `notificationEvents`, `notificationCategories` | Notification names |
| `configSections`, `settingKeys` | Settings names |
| `auditActions` | Audit log action prefixes |
| `mcpTools` | MCP tool names |
| `sseEvents` | Live event types |
| `rateLimitBuckets` | Rate limit names |

Core Orchard always wins. A claim on something core already uses, or starts
using later, is marked **taken** and skipped; the graft keeps working under its
own id. Between two grafts, a name a graft owns by id beats another graft's
claim, and otherwise the first graft in the values list wins.
