import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Doors, type DbDoor, type StorageDoor } from '@orchardlabs/graft-sdk/server';

export const THREAD_STATUSES = [
  'open',
  'acknowledged',
  'will-fix',
  'in-progress',
  'fixed',
  'wont-fix'
] as const;

export const THREAD_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const THREAD_SCOPES = ['platform', 'cli', 'mcp', 'other'] as const;

const MAX_IMAGES = 4;

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

type Author = { id: string; username: string; imageUrl: string | null };

export type Thread = {
  id: string;
  number: number;
  title: string;
  snippet: string;
  status: string;
  priority: string;
  scope: string;
  images: string[];
  pinned: boolean;
  locked: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  author: Author;
  category: { slug: string; name: string; emoji: string };
  replyCount: number;
  votes: number;
  myVote: boolean;
};

export type Reply = {
  id: string;
  body: string;
  images: string[];
  createdAt: Date;
  author: Author;
};

const AUTHOR = `json_build_object('id', u.id, 'username', u.username, 'imageUrl', u.image_url)`;

const THREAD_COLUMNS = `
  t.id,
  t.number,
  t.title,
  left(t.body, 200) AS snippet,
  t.status,
  t.priority,
  t.scope,
  coalesce(t.images, ARRAY[]::text[]) AS images,
  t.pinned,
  t.locked,
  t.created_at AT TIME ZONE 'UTC' AS "createdAt",
  t.last_activity_at AT TIME ZONE 'UTC' AS "lastActivityAt",
  ${AUTHOR} AS author,
  json_build_object('slug', c.slug, 'name', c.name, 'emoji', c.emoji) AS category,
  (SELECT count(*)::int FROM forum_replies r WHERE r.thread_id = t.id) AS "replyCount",
  (SELECT count(*)::int FROM forum_votes v WHERE v.thread_id = t.id) AS votes,
  EXISTS (SELECT 1 FROM forum_votes v WHERE v.thread_id = t.id AND v.user_id = $1) AS "myVote"`;

const THREAD_FROM = `
  FROM forum_threads t
  JOIN forum_categories c ON c.id = t.category_id
  JOIN public.users u ON u.id = t.author_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ForumService {
  constructor(
    @Inject(Doors.db) private readonly db: DbDoor,
    @Inject(Doors.storage) private readonly storage: StorageDoor
  ) {}

  private cleanImages(images: unknown): string[] {
    if (!Array.isArray(images)) return [];
    return images
      .filter((u): u is string => typeof u === 'string' && u.length <= 500 && this.storage.owns(u))
      .slice(0, MAX_IMAGES);
  }

  private purge(urls: string[]) {
    for (const url of urls.filter((u) => this.storage.owns(u))) {
      void this.storage.delete(url).catch(() => {});
    }
  }

  async listCategories() {
    const { rows } = await this.db.query(
      `SELECT c.id, c.slug, c.name, c.emoji, c.description,
              (SELECT count(*)::int FROM forum_threads t WHERE t.category_id = c.id) AS "threadCount"
         FROM forum_categories c
        ORDER BY c.sort_order ASC`
    );
    return rows;
  }

  async listThreads(opts: {
    categorySlug?: string;
    status?: string;
    scope?: string;
    sort?: string;
    userId: string;
  }): Promise<Thread[]> {
    const order =
      opts.sort === 'top'
        ? `t.pinned DESC, votes DESC, t.last_activity_at DESC`
        : `t.pinned DESC, t.last_activity_at DESC`;
    const { rows } = await this.db.query<Thread>(
      `SELECT ${THREAD_COLUMNS}
       ${THREAD_FROM}
        WHERE ($2::text IS NULL OR c.slug = $2)
          AND ($3::text IS NULL OR t.status = $3)
          AND ($4::text IS NULL OR t.scope = $4)
        ORDER BY ${order}
        LIMIT 100`,
      [
        opts.userId,
        opts.categorySlug ?? null,
        includes(THREAD_STATUSES, opts.status) ? opts.status : null,
        includes(THREAD_SCOPES, opts.scope) ? opts.scope : null
      ]
    );
    return rows;
  }

  async getThread(
    id: string,
    userId: string
  ): Promise<Thread & { body: string; replies: Reply[] }> {
    if (!UUID.test(id)) throw new NotFoundException('Thread not found');
    const { rows } = await this.db.query<Thread & { body: string; replies: Reply[] }>(
      `SELECT ${THREAD_COLUMNS},
              t.body,
              coalesce((
                SELECT json_agg(json_build_object(
                         'id', r.id,
                         'body', r.body,
                         'images', coalesce(r.images, ARRAY[]::text[]),
                         'createdAt', r.created_at AT TIME ZONE 'UTC',
                         'author', json_build_object('id', ru.id, 'username', ru.username, 'imageUrl', ru.image_url)
                       ) ORDER BY r.created_at ASC)
                  FROM forum_replies r
                  JOIN public.users ru ON ru.id = r.author_id
                 WHERE r.thread_id = t.id
              ), '[]'::json) AS replies
       ${THREAD_FROM}
        WHERE t.id = $2`,
      [userId, id]
    );
    if (!rows[0]) throw new NotFoundException('Thread not found');
    return rows[0];
  }

  async createThread(
    userId: string,
    body: { categorySlug: string; title: string; body: string; scope?: string; images?: string[] }
  ) {
    const title = body.title?.trim() ?? '';
    const text = body.body?.trim() ?? '';
    if (title.length < 4 || title.length > 200) {
      throw new BadRequestException('Title must be between 4 and 200 characters');
    }
    if (text.length < 1 || text.length > 10000) {
      throw new BadRequestException('Body must be between 1 and 10000 characters');
    }
    const scope = body.scope ?? 'platform';
    if (!includes(THREAD_SCOPES, scope)) throw new BadRequestException('Invalid scope');
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO forum_threads (category_id, author_id, title, body, scope, images, created_at, last_activity_at)
       SELECT c.id, $2, $3, $4, $5, $6, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
         FROM forum_categories c
        WHERE c.slug = $1
       RETURNING id`,
      [body.categorySlug, userId, title, text, scope, this.cleanImages(body.images)]
    );
    if (!rows[0]) throw new BadRequestException('Unknown category');
    return this.getThread(rows[0].id, userId);
  }

  async createReply(userId: string, threadId: string, text: string, images?: string[]) {
    const body = text?.trim() ?? '';
    if (body.length < 1 || body.length > 10000) {
      throw new BadRequestException('Reply must be between 1 and 10000 characters');
    }
    const thread = await this.findThread(threadId);
    if (thread.locked) throw new BadRequestException('Thread is locked');
    const { rows } = await this.db.query<Reply>(
      `WITH inserted AS (
         INSERT INTO forum_replies (thread_id, author_id, body, images, created_at)
         VALUES ($1, $2, $3, $4, now() AT TIME ZONE 'UTC')
         RETURNING *
       ), touched AS (
         UPDATE forum_threads SET last_activity_at = now() AT TIME ZONE 'UTC' WHERE id = $1
       )
       SELECT i.id, i.body, coalesce(i.images, ARRAY[]::text[]) AS images,
              i.created_at AT TIME ZONE 'UTC' AS "createdAt", ${AUTHOR} AS author
         FROM inserted i
         JOIN public.users u ON u.id = i.author_id`,
      [threadId, userId, body, this.cleanImages(images)]
    );
    return rows[0];
  }

  async deleteThread(threadId: string, userId: string, isAdmin: boolean) {
    const thread = await this.findThread(threadId);
    if (!isAdmin && thread.author_id !== userId) {
      throw new ForbiddenException('You can only delete your own posts');
    }
    const { rows } = await this.db.query<{ images: string[] }>(
      `SELECT coalesce(images, ARRAY[]::text[]) AS images FROM forum_replies WHERE thread_id = $1`,
      [threadId]
    );
    await this.db.query('DELETE FROM forum_threads WHERE id = $1', [threadId]);
    this.purge([...thread.images, ...rows.flatMap((r) => r.images)]);
    return { deleted: true };
  }

  async deleteReply(replyId: string, userId: string, isAdmin: boolean) {
    if (!UUID.test(replyId)) throw new NotFoundException('Reply not found');
    const { rows } = await this.db.query<{ author_id: string; images: string[] }>(
      `SELECT author_id, coalesce(images, ARRAY[]::text[]) AS images FROM forum_replies WHERE id = $1`,
      [replyId]
    );
    const reply = rows[0];
    if (!reply) throw new NotFoundException('Reply not found');
    if (!isAdmin && reply.author_id !== userId) {
      throw new ForbiddenException('You can only delete your own replies');
    }
    await this.db.query('DELETE FROM forum_replies WHERE id = $1', [replyId]);
    this.purge(reply.images);
    return { deleted: true };
  }

  async setVote(userId: string, threadId: string, on: boolean) {
    await this.findThread(threadId);
    if (on) {
      await this.db.query(
        `INSERT INTO forum_votes (thread_id, user_id, created_at)
         VALUES ($1, $2, now() AT TIME ZONE 'UTC')
         ON CONFLICT DO NOTHING`,
        [threadId, userId]
      );
    } else {
      await this.db.query('DELETE FROM forum_votes WHERE thread_id = $1 AND user_id = $2', [
        threadId,
        userId
      ]);
    }
    const { rows } = await this.db.query<{ votes: number }>(
      'SELECT count(*)::int AS votes FROM forum_votes WHERE thread_id = $1',
      [threadId]
    );
    return { votes: rows[0].votes, myVote: on };
  }

  async setStatus(threadId: string, status: string) {
    if (!includes(THREAD_STATUSES, status)) throw new BadRequestException('Invalid status');
    await this.update(threadId, 'status', status);
    return { status };
  }

  async setPriority(threadId: string, priority: string) {
    if (!includes(THREAD_PRIORITIES, priority)) throw new BadRequestException('Invalid priority');
    await this.update(threadId, 'priority', priority);
    return { priority };
  }

  async setPinned(threadId: string, pinned: boolean) {
    await this.update(threadId, 'pinned', pinned);
    return { pinned };
  }

  async setLocked(threadId: string, locked: boolean) {
    await this.update(threadId, 'locked', locked);
    return { locked };
  }

  private async update(
    threadId: string,
    column: 'status' | 'priority' | 'pinned' | 'locked',
    value: string | boolean
  ) {
    if (!UUID.test(threadId)) throw new NotFoundException('Thread not found');
    const { rowCount } = await this.db.query(
      `UPDATE forum_threads SET ${column} = $2 WHERE id = $1`,
      [threadId, value]
    );
    if (!rowCount) throw new NotFoundException('Thread not found');
  }

  private async findThread(id: string) {
    if (!UUID.test(id)) throw new NotFoundException('Thread not found');
    const { rows } = await this.db.query<{ author_id: string; locked: boolean; images: string[] }>(
      `SELECT author_id, locked, coalesce(images, ARRAY[]::text[]) AS images FROM forum_threads WHERE id = $1`,
      [id]
    );
    if (!rows[0]) throw new NotFoundException('Thread not found');
    return rows[0];
  }
}
