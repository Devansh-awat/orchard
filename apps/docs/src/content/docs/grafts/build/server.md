---
title: Server code and doors
description: Write a graft's API as a NestJS module, and reach Orchard through doors.
sidebar:
  order: 3
---

A graft's server code is a NestJS module, the default export of
`server/src/index.ts`. Orchard mounts every controller in it under
`/apiv1/<graft-id>/`, including controllers in modules it imports.

```ts
import { Controller, Get, Inject, Module, Param } from '@nestjs/common';
import { Auth, Doors, GraftUserId, type AuthDoor, type DbDoor } from '@orchard/graft-sdk/server';

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

## Who can call a route

Grafts use the same rules as Orchard itself, and the same default:

| Decorator | Route is open to |
| --- | --- |
| none | Superadmins only |
| `@Auth()` | Anyone signed in. Check what they may see with `Doors.auth` |
| `@Public()` | Anyone. Must also be listed in `graft.json` `public.routes` |
| `@RequireScope('read' \| 'deploy' \| 'exec')` | API tokens need that scope |

`@GraftUserId()` gives you the signed-in user's id. `graft pack` records every
route and its access level, and Orchard refuses to load a graft whose routes no
longer match.

## Doors

Everything a graft needs from Orchard comes through a door, injected with
`@Inject(Doors.<name>)`. Doors know which graft injected them, so a door whose
capability is missing from `graft.json` stops the graft from booting with a
message saying which one. The [graft API reference](/reference/graft-api/) lists
every door and member.

| Door | For |
| --- | --- |
| `context` | The graft's own id, version, manifest, schema and API base |
| `auth` | Organization and project access checks, and the graft's own permissions with `can()` and `require()` |
| `users` | Basic profile data of other users |
| `db` | A connection pool to the graft's own schema |
| `settings` | Values of the graft's settings sections |
| `secrets` | Encrypt and decrypt with Orchard's secret key |
| `audit` | Write audit log entries, under the graft's own action names |
| `events` | Send live events to an organization's open pages, and listen to Orchard's |
| `flags` | Feature flags |
| `http` | Websocket endpoints, raw access to the HTTP server once it listens, and serving whole hostnames for preview domains |
| `kube` | The cluster client, leader election and registering a mirror shard so resources are watched into Postgres |
| `apply` | Queue cluster changes on Orchard's retrying apply queue and handle the graft's own operations |
| `exec` | Terminals into the graft's own workloads through Orchard's session engine, with reattach and replica hand-off |
| `projects` | Create and rebuild deployments and environments as a user, and hear when an environment's variables change |
| `notifications` | Register notification events and categories, and notify a person |
| `rateLimit` | Rate limit buckets shared across replicas |
| `metrics` | Instant queries against the metrics store |
| `github` | GitHub tokens for a user, a repository or an app installation, and issue comment webhooks |

Grafts bundle their own dependencies. `@nestjs/*`, `rxjs` and `reflect-metadata`
come from Orchard so there is one Nest; list anything else that must not be
bundled in `graft.config.mjs` under `server.external`.

## MCP tools

Export a function from `mcp/src/index.ts` and add the `mcp` capability. Tools run
in Orchard's MCP server and call the graft's API as the signed-in user:

```ts
import { defineMcp } from '@orchard/graft-sdk/server';

export default defineMcp((server, client, { apiBase }) => {
  server.registerTool('notes_list', { description: 'List notes' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(await client.get(`${apiBase}/notes`)) }]
  }));
});
```

Tool names start with the graft id with dashes turned into underscores, or are
listed under `claims.mcpTools`.
