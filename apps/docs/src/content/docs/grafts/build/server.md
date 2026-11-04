---
title: Write server code
description: Write an Orchard graft's API as a NestJS module, control who can call each route, and reach Orchard through versioned doors.
sidebar:
  order: 3
---

Add API routes to a graft. A graft's server code is a NestJS module, the default export of `server/src/index.ts`. Orchard mounts each controller in it under `/apiv1/<graft-id>/`, including controllers in modules it imports.

```ts
import { Controller, Get, Inject, Module, Param } from '@nestjs/common';
import { Auth, Doors, GraftUserId, type AuthDoor, type DbDoor } from '@orchardlabs/graft-sdk/server';

@Controller('notes')
class NotesController {
  constructor(
    @Inject(Doors.db) private readonly db: DbDoor,
    @Inject(Doors.auth) private readonly auth: AuthDoor
  ) {}

  @Get(':orgId')
  @Auth()
  async list(@GraftUserId() userId: string, @Param('orgId') orgId: string) {
    await this.auth.requireOrgMember(orgId, userId);
    return (await this.db.query('SELECT * FROM notes WHERE org_id = $1', [orgId])).rows;
  }
}

@Module({ controllers: [NotesController] })
export default class NotesModule {}
```

## Control who can call a route

A route with no decorator is open to superadmins only.

| Decorator | Route is open to |
| --- | --- |
| None | Superadmins only |
| `@SuperAdmin()` | Superadmins only |
| `@Auth()` | Anyone signed in. Check what they can see with `Doors.auth`. |
| `@Public()` | Anyone. The route must also be listed in `public.routes` in `graft.json`. |
| `@RequireScope('read' \| 'deploy' \| 'exec')` | API tokens need this scope. |

`@GraftUserId()` gives you the signed-in user's ID.

`graft pack` records each route and its access level. Orchard refuses to load a graft whose routes no longer match that record.

## Use doors

A graft reaches Orchard through doors. Inject a door with `@Inject(Doors.<name>)`. A door checks which graft injected it. If the door's capability is missing from `graft.json`, the graft does not boot, and the message names the capability.

For each door's members, version, and capability, refer to the [graft API reference](/reference/graft-api/).

| Door | Purpose |
| --- | --- |
| `context` | The graft's ID, version, manifest, schema, and API base. |
| `auth` | Organization and project access checks, and the graft's own permissions with `can()` and `require()`. |
| `users` | Basic profile data of other users. |
| `db` | A connection pool to the graft's schema. |
| `settings` | Values of the graft's settings sections. |
| `secrets` | Encryption and decryption with Orchard's secret key. |
| `storage` | Uploads to and deletions from the instance's object storage. |
| `audit` | Audit log entries, under the graft's action names. |
| `events` | Live events to an organization's open pages, and Orchard's event stream. |
| `flags` | Feature flags. |
| `http` | WebSocket endpoints, the HTTP server once it listens, and hostnames for preview domains. |
| `kube` | The cluster client, leader election, and Engine shards that watch resources into Postgres. |
| `apply` | Cluster changes on Orchard's retrying apply queue, and handlers for the graft's operations. |
| `exec` | Terminals into the graft's workloads through Orchard's session engine. |
| `projects` | Deployments and environments, and environment variable changes. Changes need the `projects.write` capability. |
| `notifications` | Notification events, and notifications to a person. |
| `rateLimit` | Rate limit buckets shared across replicas. |
| `metrics` | Instant queries against the metrics store. |
| `github` | GitHub tokens for a user, a repository, or an app installation, and issue comment webhooks. |

## Bundle dependencies

Grafts bundle their own dependencies. `@nestjs/*`, `rxjs`, and `reflect-metadata` come from Orchard, so that there is one Nest instance. To leave another package out of the bundle, list it in `graft.config.mjs` under `server.external`.

## Add MCP tools

1. Add the `mcp` capability to `graft.json`.
2. Export a function from `mcp/src/index.ts`:

   ```ts
   import { defineMcp } from '@orchardlabs/graft-sdk/server';

   export default defineMcp((server, client, { apiBase }) => {
     server.registerTool('notes_list', { description: 'List notes' }, async () => ({
       content: [{ type: 'text', text: JSON.stringify(await client.get(`${apiBase}/notes`)) }]
     }));
   });
   ```

Tools run in Orchard's MCP server and call the graft's API as the signed-in user.

A tool's name must start with the graft's ID, with dashes turned into underscores, or be listed under `claims.mcpTools`.

:::note
If a graft has both MCP tools and the `flags` capability, and the instance has PostHog configured, Orchard treats the graft as gated on a flag named after its ID. Accounts without that flag do not see the graft's tools.
:::

## Gate a graft with a feature flag

Use the `flags` door to limit a graft to some accounts. Check `configured` first, so that the graft stays open on instances without PostHog:

```ts
if (this.flags.configured && !(await this.flags.isEnabled('notes', userId))) {
  throw new NotFoundException();
}
```

## Related resources

- [graft.json](/grafts/build/manifest/)
- [Use the database](/grafts/build/database/)
- [Graft API versions](/reference/graft-api/)
