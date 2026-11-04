---
title: graft.json
description: Review each field of graft.json, the Orchard graft manifest, how claims work, and which names a graft owns without a claim.
sidebar:
  order: 2
---

`graft.json` is the manifest that Orchard reads before it runs a graft's code. Orchard refuses unknown fields when it checks or loads a graft. `graft pack` checks only the required fields, so use `orchardctl graft add --dry-run` to validate the whole file.

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

## Fields

| Field | Description |
| --- | --- |
| `id` | 2 to 48 lowercase letters, digits, and dashes, starting with a letter. It is the graft's URL prefix and namespace. Names in Orchard such as `admin` and `api` are reserved. |
| `name`, `version`, `publisher`, `description`, `homepage`, `icon` | Shown in the Extension Marketplace and in **Instance admin** > **Grafts**. `version` is a semver version. |
| `engines.platform` | The Orchard versions the graft works with, as a semver range. |
| `engines.sdk` | The graft SDK versions it was built against. |
| `uses` | Filled in by `graft pack`. The doors and versions the server code injects. |
| `requires.grafts` | Other grafts it needs, with version ranges. |
| `requires.kubernetes.crds` | CRDs that must exist. `orchardctl` checks them before it installs the graft. |
| `requires.kubernetes.verbs` | Kubernetes API verbs the graft uses, each with `group`, `resource`, `verb`, and an optional `namespace`. |
| `capabilities` | What the graft asks for. Each door needs its capability. Refer to the [graft API reference](/reference/graft-api/). |
| `database.coreReads` | Core tables and columns the graft can read, for joins. Shown before install. |
| `database.adopts` | Core tables the graft takes over from an older Orchard that included the feature. Its first migration moves them into its own schema and leaves a view with the old name. Shown before install. The Extension Marketplace accepts this only from official grafts. |
| `database.pool` | Database connections per pod, from 1 to 50. The default is 3. Operators can override it. |
| `permissions` | Permissions the graft checks, with default grants by role. For example, `{ "use": { "label": "Use it", "defaultGrants": ["org:member"] } }`. |
| `settings` | Sections for **Instance admin** > **Configuration**. Refer to [Settings](#settings). |
| `ui.screens` | Pages the graft owns: `id`, `path` (with `:param` and a trailing `*`), `layout` (`shell` or `fullscreen`), `title`, and optional `og` metadata. |
| `public.routes` | Every route open to anyone, as `"POST /hooks/github"`. Orchard refuses a public route that is not listed. |
| `claims` | Names outside the graft's own ID. Refer to [Claims](#claims). |
| `entries` | Filled in by `graft pack`. |

## Settings

Each section has an `id`, a `title`, and `fields`. It can also have a `description`, a `storageKey`, and a `required` list of field keys.

| Field property | Description |
| --- | --- |
| `key` | The field's key. |
| `type` | `string`, `text`, `number`, `boolean`, `select`, or `secret`. |
| `label`, `help` | The text in **Instance admin**. |
| `env` | An environment variable that overrides the field. |
| `options` | The choices for a `select` field. |
| `default` | The default value. |

Only instance-scoped fields are supported. A field with another `scope` adds a warning in **Instance admin** > **Grafts**.

## Claims

A graft owns `/apiv1/<id>/...`, `/<id>/...`, and names that start with `<id>.`, `<id>-`, `<id>/`, `<id>:`, or `<id>_` without a claim. A name outside that is a claim. Orchard shows claims to the operator before install.

| Claim | Purpose |
| --- | --- |
| `apiAliases` | API paths. For example, `sandboxes` serves `/apiv1/sandboxes/...` from the graft's `sandboxes` controller. |
| `uiAliases` | Top-level page paths. |
| `wsAliases` | WebSocket paths. |
| `hostRouting` | Hostnames the graft serves directly, for preview domains. |
| `notificationEvents`, `notificationCategories` | Notification names. |
| `configSections`, `settingKeys` | Settings names. |
| `auditActions` | Audit log action prefixes. |
| `mcpTools` | MCP tool names. |
| `sseEvents` | Live event types. |
| `rateLimitBuckets` | Rate limit names. |
| `applyOps` | Apply queue operation names the graft handles. |
| `deviceNames` | Session device name prefixes for organization-scoped tokens the graft mints. |
| `engineShards` | Engine shard names the graft registers. `mirrorShards` is an older name for this claim, and it still works. |

### Conflicts

Between two grafts, a name that one graft owns by its ID beats the other graft's claim. Otherwise, the first graft in the values list wins. The losing claim shows as **taken** in **Instance admin** > **Grafts** and is skipped. The graft keeps working under its own ID.

For an `apiAliases` claim, a core route that handles the same path and method takes priority on each request.

`graft doctor` notes each alias claim, because core Orchard can start using that path later.
