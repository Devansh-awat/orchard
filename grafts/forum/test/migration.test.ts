import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { ForumService } from '../server/src/forum.service';

const coreMigrations = resolve(__dirname, '../../../apps/server/prisma/migrations');
const legacy = [
  '20260716000000_forum',
  '20260717000000_forum_issue_tracker',
  '20260718000000_forum_scope'
].map((m) => readFileSync(resolve(coreMigrations, m, 'migration.sql'), 'utf8'));
const adopt = readFileSync(resolve(__dirname, '../migrations/0001_adopt/migration.sql'), 'utf8');

const SEB = '11111111-1111-4111-8111-111111111111';
const PUP = '22222222-2222-4222-8222-222222222222';
const CATEGORY = 'aaaaaaaa-0000-4000-8000-000000000001';
const THREAD = 'bbbbbbbb-0000-4000-8000-000000000001';

async function boot(withLegacyTables: boolean) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, username text, image_url text);
    INSERT INTO users VALUES ('${SEB}', 'seb', NULL), ('${PUP}', 'pup', 'https://img/pup.png');
  `);
  if (withLegacyTables) {
    for (const sql of legacy) await pg.exec(sql);
    await pg.exec(`
      INSERT INTO forum_categories (id, slug, name, emoji) VALUES ('${CATEGORY}', 'bugs', 'Bugs', '');
      INSERT INTO forum_threads (id, category_id, author_id, title, body)
        VALUES ('${THREAD}', '${CATEGORY}', '${SEB}', 'old thread', 'body');
      INSERT INTO forum_replies (id, thread_id, author_id, body)
        VALUES ('cccccccc-0000-4000-8000-000000000001', '${THREAD}', '${PUP}', 'hi');
      INSERT INTO forum_votes (thread_id, user_id) VALUES ('${THREAD}', '${PUP}');
    `);
  }
  await pg.exec(`
    BEGIN;
    CREATE SCHEMA IF NOT EXISTS ext_forum;
    SET LOCAL search_path TO ext_forum, public;
    ${adopt};
    COMMIT;
    SET search_path TO ext_forum, public;
  `);
  const db = {
    schema: 'ext_forum',
    role: null,
    pool: () => {
      throw new Error('unused');
    },
    query: async (text: string, values?: unknown[]) => {
      const r = await pg.query(text, values as never[]);
      return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length };
    }
  };
  const deleted: string[] = [];
  const storage = {
    configured: true,
    publicBase: 'https://cdn/forum/',
    owns: (url: string) => url.startsWith('https://cdn/forum/'),
    upload: async () => 'https://cdn/forum/new.png',
    delete: async (url: string) => {
      deleted.push(url);
    }
  };
  return { pg, forum: new ForumService(db as never, storage as never), deleted };
}

async function relations(pg: PGlite) {
  const { rows } = await pg.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname LIKE 'forum\\_%' AND c.relkind IN ('r', 'v')
      ORDER BY 1`
  );
  return rows.map((r) => r.name);
}

const MOVED = [
  'ext_forum.forum_categories:r',
  'ext_forum.forum_replies:r',
  'ext_forum.forum_threads:r',
  'ext_forum.forum_votes:r',
  'public.forum_categories:v',
  'public.forum_replies:v',
  'public.forum_threads:v',
  'public.forum_votes:v'
];

test('an existing grove moves into ext_forum with its data intact', async () => {
  const { pg, forum } = await boot(true);
  assert.deepEqual(await relations(pg), MOVED);
  const [thread] = await forum.listThreads({ userId: PUP });
  assert.equal(thread.title, 'old thread');
  assert.equal(thread.author.username, 'seb');
  assert.deepEqual([thread.votes, thread.replyCount, thread.myVote], [1, 1, true]);
  const created = await forum.createThread(SEB, {
    categorySlug: 'features',
    title: 'new thing',
    body: 'please'
  });
  assert.equal(created.number, 2);
  await pg.close();
});

test('pods on the previous release keep writing through the compat views', async () => {
  const { pg } = await boot(true);
  await pg.exec(`
    SET search_path TO public;
    INSERT INTO forum_threads (id, category_id, author_id, title, body)
      VALUES ('bbbbbbbb-0000-4000-8000-000000000002', '${CATEGORY}', '${SEB}', 'via view', 'b');
  `);
  const { rows } = await pg.query<{ number: number; status: string }>(
    `SELECT number, status FROM ext_forum.forum_threads WHERE title = 'via view'`
  );
  assert.deepEqual(rows[0], { number: 2, status: 'open' });
  await pg.close();
});

test('a fresh install creates the tables and seeds the categories', async () => {
  const { pg, forum } = await boot(false);
  assert.deepEqual(await relations(pg), MOVED);
  assert.deepEqual(
    (await forum.listCategories()).map((c) => c.slug),
    ['bugs', 'features']
  );
  await pg.close();
});

test('threads, replies, votes, moderation and deletes work against the moved tables', async () => {
  const { pg, forum, deleted } = await boot(false);
  const thread = await forum.createThread(SEB, {
    categorySlug: 'bugs',
    title: 'it broke',
    body: 'details',
    images: ['https://cdn/forum/a.png', 'https://elsewhere/x.png']
  });
  assert.equal(thread.number, 1);
  assert.deepEqual(thread.images, ['https://cdn/forum/a.png']);
  assert.ok(Math.abs(thread.createdAt.getTime() - Date.now()) < 60_000);

  const reply = await forum.createReply(PUP, thread.id, 'same here', ['https://cdn/forum/b.png']);
  assert.equal(reply.author.username, 'pup');
  assert.equal((await forum.getThread(thread.id, SEB)).replies.length, 1);

  assert.equal((await forum.setVote(PUP, thread.id, true)).votes, 1);
  assert.equal((await forum.setVote(PUP, thread.id, true)).votes, 1);
  const top = await forum.listThreads({
    userId: PUP,
    sort: 'top',
    categorySlug: 'bugs',
    status: 'open',
    scope: 'platform'
  });
  assert.equal(top[0]?.myVote, true);

  await forum.setStatus(thread.id, 'fixed');
  await forum.setPriority(thread.id, 'high');
  await forum.setPinned(thread.id, true);
  await forum.setLocked(thread.id, true);
  const moderated = await forum.getThread(thread.id, SEB);
  assert.deepEqual(
    [moderated.status, moderated.priority, moderated.pinned, moderated.locked],
    ['fixed', 'high', true, true]
  );
  await assert.rejects(forum.createReply(SEB, thread.id, 'more'), /locked/);
  await assert.rejects(forum.setStatus(thread.id, 'whatever'), /Invalid status/);

  await assert.rejects(forum.deleteThread(thread.id, PUP, false), /your own/);
  await forum.deleteThread(thread.id, SEB, false);
  assert.deepEqual(deleted.sort(), ['https://cdn/forum/a.png', 'https://cdn/forum/b.png']);
  await assert.rejects(forum.getThread(thread.id, SEB), /not found/);
  await assert.rejects(forum.getThread('not-a-uuid', SEB), /not found/);
  await pg.close();
});
