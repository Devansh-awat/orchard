import type { HostApi } from '@orchardlabs/graft-sdk/client';

export type Announcement = {
  id: string;
  body: string;
  tone: 'info' | 'success' | 'warning';
  createdAt: string;
  expiresAt: string | null;
  author: string | null;
};

export const listAnnouncements = (host: HostApi) => host.api<Announcement[]>('/announcements');

export const createAnnouncement = (
  host: HostApi,
  input: { body: string; tone: Announcement['tone']; expiresInHours: number }
) => host.api<Announcement>('/announcements', { method: 'POST', json: input });

export const removeAnnouncement = (host: HostApi, id: string) =>
  host.api<{ removed: boolean }>(`/announcements/${id}`, { method: 'DELETE' });
