import { Injectable } from '@nestjs/common';
import { AuthorizationService, ProjectAccess } from '../auth/authorization.service';
import { NotificationMessage } from './notification-events';

const TTL_MS = 15_000;
const MAX_ENTRIES = 5_000;
const PUBLIC_FIELDS = new Set(['Branch', 'Trigger']);

export const REDACTED_BODY = 'Open Orchard to see the details.';

export function redactForViewer(message: NotificationMessage): NotificationMessage {
  return {
    ...message,
    body: REDACTED_BODY,
    fields: message.fields?.filter((f) => PUBLIC_FIELDS.has(f.name))
  };
}

@Injectable()
export class NotificationAccessService {
  private readonly cache = new Map<string, { at: number; access: ProjectAccess | null }>();

  constructor(private readonly authz: AuthorizationService) {}

  async resolve(projectId: string, userId: string): Promise<ProjectAccess | null> {
    const key = `${projectId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.access;
    const access = await this.authz.getProjectAccess(projectId, userId);
    if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), access });
    return access;
  }

  async viewers(projectId: string, userIds: string[]): Promise<Map<string, ProjectAccess>> {
    const out = new Map<string, ProjectAccess>();
    await Promise.all(
      userIds.map(async (id) => {
        const access = await this.resolve(projectId, id);
        if (access?.canView) out.set(id, access);
      })
    );
    return out;
  }
}
