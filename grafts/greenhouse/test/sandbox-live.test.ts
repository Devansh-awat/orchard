import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { MemoryLiveBackend, MemoryLiveNetwork } from '../server/src/sandboxes/live/live-backend';
import { KICK_CODE, LiveSocket, SandboxLiveHub } from '../server/src/sandboxes/live/live-hub';
import { YRoomFiles, YRoomManager, contentHash } from '../server/src/sandboxes/live/yjs-rooms';
import {
  FrameQueue,
  LIVE_LIMITS,
  parseClientFrame,
  parseRoom,
  stripControl
} from '../server/src/sandboxes/live/live-protocol';
import { normalizeRelativePath } from '../server/src/sandboxes/sandbox-session-commands';
import type { SandboxRole } from '../server/src/sandboxes/sandbox-access.service';
import {
  PREVIEW_COOKIE,
  forwardableCookies,
  mintPreviewToken,
  parsePreviewHost,
  previewDomainConflict,
  previewRequestAllowed,
  redeemPreviewToken,
  signPreviewCookie,
  verifyPreviewCookie
} from '../server/src/sandboxes/preview/preview-auth';
import {
  OPENCODE_MESSAGE_ID_RE,
  newOpencodeMessageId,
  opencodePromptTarget,
  opencodeReplyTarget
} from '../server/src/sandboxes/sandbox-opencode-policy';
import { needsAttention } from '../server/src/sandboxes/sandbox-attention.service';

const SANDBOX = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const CHAT = 'ses_abc123';

class FakeSocket implements LiveSocket {
  readyState = 1;

  bufferedAmount = 0;

  sent: Array<Record<string, any>> = [];

  closed: { code?: number; reason?: string } | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  frames(t: string) {
    return this.sent.filter((f) => f.t === t);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function harness(roles: Record<string, SandboxRole | null>) {
  const network = new MemoryLiveNetwork();
  const backend = new MemoryLiveBackend(network, 'replica-a');
  const comments: unknown[] = [];
  const hub = new SandboxLiveHub({
    backend,
    rooms: null,
    resolveRole: async (_s, userId) => roles[userId] ?? null,
    validateSession: async () => true,
    sessionBelongs: async (_s, sid) => sid === SID,
    postComment: async (input) => {
      comments.push(input);
      return input;
    },
    normalizePath: normalizeRelativePath,
    recheckMs: 60_000
  });
  const join = (userId: string) => {
    const socket = new FakeSocket();
    const conn = hub.attach({
      sandboxId: SANDBOX,
      userId,
      sessionId: null,
      orgScope: null,
      user: { id: userId, name: userId, avatarUrl: null },
      role: roles[userId]!,
      sid: SID,
      socket
    });
    return { conn, socket };
  };
  return { hub, backend, join, comments };
}

test('viewers cannot draft, comment or save over the live channel', async () => {
  const { hub, join, comments } = harness({ host: 'owner', watcher: 'viewer' });
  const host = join('host');
  const watcher = join('watcher');
  await tick();
  await hub.handleMessage(
    watcher.conn,
    JSON.stringify({ t: 'draft', sid: SID, chatId: CHAT, text: 'hi' })
  );
  await hub.handleMessage(
    watcher.conn,
    JSON.stringify({ t: 'comment', sid: SID, chatId: CHAT, body: 'hi' })
  );
  await hub.handleMessage(
    watcher.conn,
    JSON.stringify({ t: 'yjs-save', room: `file:${SID}:a.ts` })
  );
  await tick();
  assert.equal(watcher.socket.frames('error').filter((f) => f.code === 'forbidden').length, 3);
  assert.equal(host.socket.frames('draft').length, 0);
  assert.equal(comments.length, 0);
  await hub.close();
});

test('a guest draft reaches everyone else but never echoes back', async () => {
  const { hub, join } = harness({ host: 'owner', guest: 'collaborator' });
  const host = join('host');
  const guest = join('guest');
  await tick();
  await hub.handleMessage(
    guest.conn,
    JSON.stringify({ t: 'draft', sid: SID, chatId: CHAT, text: 'fix it' })
  );
  await tick();
  const drafts = host.socket.frames('draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].text, 'fix it');
  assert.equal(drafts[0].user.id, 'guest');
  assert.equal(guest.socket.frames('draft').length, 0);
  await hub.close();
});

test('drafts for a session in another sandbox are refused', async () => {
  const { hub, join } = harness({ guest: 'collaborator' });
  const guest = join('guest');
  await hub.handleMessage(
    guest.conn,
    JSON.stringify({
      t: 'draft',
      sid: '99999999-9999-4999-8999-999999999999',
      chatId: CHAT,
      text: 'x'
    })
  );
  assert.equal(guest.socket.frames('error').at(-1)?.code, 'bad_sid');
  await hub.close();
});

test('removing a member kicks their live connection and a downgrade is pushed', async () => {
  const roles: Record<string, SandboxRole | null> = {
    host: 'owner',
    guest: 'collaborator',
    pal: 'collaborator'
  };
  const { hub, join } = harness(roles);
  join('host');
  const guest = join('guest');
  const pal = join('pal');
  await tick();
  roles.guest = null;
  roles.pal = 'viewer';
  await hub.aclChanged(SANDBOX);
  await tick();
  assert.equal(guest.socket.closed?.code, KICK_CODE);
  assert.equal(guest.socket.frames('kicked').length, 1);
  assert.equal(pal.socket.closed, null);
  assert.deepEqual(pal.socket.frames('role').at(-1), { t: 'role', role: 'viewer' });
  await hub.handleMessage(
    pal.conn,
    JSON.stringify({ t: 'draft', sid: SID, chatId: CHAT, text: 'x' })
  );
  assert.equal(pal.socket.frames('error').at(-1)?.code, 'forbidden');
  await hub.close();
});

test('drafts are rate limited', async () => {
  const { hub, join } = harness({ guest: 'collaborator' });
  const guest = join('guest');
  for (let i = 0; i < 30; i++) {
    await hub.handleMessage(
      guest.conn,
      JSON.stringify({ t: 'draft', sid: SID, chatId: CHAT, text: `${i}` })
    );
  }
  assert.ok(guest.socket.frames('error').some((f) => f.code === 'rate_limited'));
  await hub.close();
});

test('the roster lists each person once with their highest role', async () => {
  const { hub, join } = harness({ host: 'owner', guest: 'collaborator' });
  join('host');
  join('host');
  join('guest');
  await tick();
  const roster = await hub.roster(SANDBOX);
  assert.deepEqual(
    roster.map((u) => [u.id, u.role]),
    [
      ['guest', 'collaborator'],
      ['host', 'owner']
    ]
  );
  await hub.close();
});

test('live frames reject junk and strip bidi and control characters', () => {
  assert.equal(parseClientFrame('nope').ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ t: 'exec' })).ok, false);
  assert.equal(
    parseClientFrame(JSON.stringify({ t: 'draft', sid: 'x', chatId: CHAT, text: '' })).ok,
    false
  );
  const dirty = ['a', 0x202e, 'b', 0, 'c', 0x200b, 'd\n']
    .map((p) => (typeof p === 'number' ? String.fromCharCode(p) : p))
    .join('');
  assert.equal(stripControl(dirty), 'abcd\n');
  assert.equal(parseRoom(`file:${SID}:src/a.ts`, normalizeRelativePath)?.path, 'src/a.ts');
  assert.equal(parseRoom(`file:${SID}:../etc/passwd`, normalizeRelativePath), null);
  assert.equal(parseRoom(`file:${SID}:/etc/passwd`, normalizeRelativePath), null);
  assert.equal(parseRoom(`term:${SID}:a`, normalizeRelativePath), null);
});

class MemoryFiles implements YRoomFiles {
  files = new Map<string, string>();

  writes = 0;

  async read(_s: string, _sid: string, path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error('missing');
    return { content, hash: contentHash(content) };
  }

  async stat(_s: string, _sid: string, path: string) {
    const content = this.files.get(path);
    return content === undefined ? null : contentHash(content);
  }

  async write(_s: string, _sid: string, path: string, content: string) {
    this.writes += 1;
    this.files.set(path, content);
    return contentHash(content);
  }
}

function updateFrame(apply: (doc: Y.Doc) => void): string {
  const doc = new Y.Doc();
  apply(doc);
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  return Buffer.from(encoding.toUint8Array(encoder)).toString('base64');
}

test('yjs updates from viewers are dropped and guest edits are saved', async () => {
  const network = new MemoryLiveNetwork();
  const backend = new MemoryLiveBackend(network, 'replica-a');
  const delivered: Array<{ connId: string; frame: Record<string, any> }> = [];
  const files = new MemoryFiles();
  files.files.set('a.ts', 'hello');
  const rooms = new YRoomManager(
    backend,
    {
      replicaId: 'replica-a',
      deliverLocal: (connId, frame) => delivered.push({ connId, frame }),
      publish: async () => {}
    },
    files,
    { saveDebounceMs: 10, pollMs: 60_000, ownerHeartbeatMs: 60_000 }
  );
  const room = `file:${SID}:a.ts`;
  const viewer = {
    replica: 'replica-a',
    connId: 'v',
    userId: 'v',
    role: 'viewer' as const,
    name: 'v',
    color: 0
  };
  const guest = {
    replica: 'replica-a',
    connId: 'g',
    userId: 'g',
    role: 'collaborator' as const,
    name: 'g',
    color: 1
  };
  await rooms.handleLocal(SANDBOX, room, viewer, { t: 'yjs-reload' });
  assert.equal(rooms.roomText(room), 'hello');
  const b64 = updateFrame((doc) => doc.getText('content').insert(0, 'evil '));
  await rooms.handleLocal(SANDBOX, room, viewer, { t: 'yjs', b64, gen: null });
  assert.equal(rooms.roomText(room), 'hello');
  assert.ok(delivered.some((d) => d.connId === 'v' && d.frame.t === 'yjs-denied'));
  await rooms.handleLocal(SANDBOX, room, viewer, { t: 'yjs-save' });
  assert.equal(files.writes, 0);
  await rooms.handleLocal(SANDBOX, room, guest, { t: 'yjs-reload' });
  const synced = new Y.Doc();
  const seed = delivered.find((d) => d.connId === 'g' && d.frame.t === 'yjs');
  assert.ok(seed, 'guest receives sync step 1');
  const text = rooms.roomText(room)!;
  synced.getText('content').insert(0, text);
  const edit = updateFrame((doc) => doc.getText('content').insert(0, 'guest '));
  await rooms.handleLocal(SANDBOX, room, guest, { t: 'yjs', b64: edit, gen: null });
  assert.match(rooms.roomText(room)!, /guest /);
  await rooms.handleLocal(SANDBOX, room, guest, { t: 'yjs-save' });
  assert.equal(files.writes, 1);
  assert.match(files.files.get('a.ts')!, /guest /);
  await rooms.close();
  await backend.close();
});

test('a guest cannot grow a shared doc outside its text or alias a room by case', async () => {
  const network = new MemoryLiveNetwork();
  const backend = new MemoryLiveBackend(network, 'replica-a');
  const delivered: Array<{ connId: string; frame: Record<string, any> }> = [];
  const files = new MemoryFiles();
  files.files.set('a.ts', 'hello');
  const rooms = new YRoomManager(
    backend,
    {
      replicaId: 'replica-a',
      deliverLocal: (connId, frame) => delivered.push({ connId, frame }),
      publish: async () => {}
    },
    files,
    { saveDebounceMs: 10, pollMs: 60_000, ownerHeartbeatMs: 60_000 }
  );
  const room = `file:${SID}:a.ts`;
  const guest = {
    replica: 'replica-a',
    connId: 'g',
    userId: 'g',
    role: 'collaborator' as const,
    name: 'g',
    color: 1
  };
  await rooms.handleLocal(SANDBOX, room, guest, { t: 'yjs-reload' });
  const junk = updateFrame((doc) => doc.getText('junk').insert(0, 'x'.repeat(10_000)));
  await rooms.handleLocal(SANDBOX, room, guest, { t: 'yjs', b64: junk, gen: null });
  assert.ok(delivered.some((d) => d.connId === 'g' && d.frame.t === 'yjs-reset'));
  assert.equal(rooms.roomText(room), 'hello');
  const dangling = new Y.Doc();
  dangling.getText('content').insert(0, 'a');
  const before = Y.encodeStateVector(dangling);
  dangling.getText('content').insert(1, 'b');
  const tail = Y.encodeStateAsUpdate(dangling, before);
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, tail);
  delivered.length = 0;
  await rooms.handleLocal(SANDBOX, room, guest, {
    t: 'yjs',
    b64: Buffer.from(encoding.toUint8Array(encoder)).toString('base64'),
    gen: null
  });
  assert.ok(delivered.some((d) => d.connId === 'g' && d.frame.t === 'yjs-reset'));
  assert.equal(rooms.roomText(room), 'hello');
  const lettered = 'abcdef12-2222-4222-8222-222222222222';
  assert.equal(parseRoom(`file:${lettered.toUpperCase()}:a.ts`, normalizeRelativePath), null);
  assert.ok(parseRoom(`file:${lettered}:a.ts`, normalizeRelativePath));
  assert.ok(LIVE_LIMITS.room.burst <= 20 && LIVE_LIMITS.room.rate <= 2);
  await rooms.close();
  await backend.close();
});

test('preview tokens are single use and bound to their host and port', async () => {
  const backend = new MemoryLiveBackend();
  const secret = 'x'.repeat(32);
  const host = parsePreviewHost(`3000-${SANDBOX.slice(0, 8)}.preview.test`, 'preview.test')!;
  assert.ok(host);
  const token = await mintPreviewToken(backend, secret, {
    sandboxId: SANDBOX,
    userId: 'u',
    port: 3000
  });
  const otherPort = parsePreviewHost(`5173-${SANDBOX.slice(0, 8)}.preview.test`, 'preview.test')!;
  assert.equal(await redeemPreviewToken(backend, secret, token, otherPort), null);
  assert.ok(await redeemPreviewToken(backend, secret, token, host));
  assert.equal(await redeemPreviewToken(backend, secret, token, host), null, 'second use fails');
  const late = await mintPreviewToken(
    backend,
    secret,
    { sandboxId: SANDBOX, userId: 'u', port: 3000 },
    Date.now() - 120_000
  );
  assert.equal(await redeemPreviewToken(backend, secret, late, host), null, 'expired');
  assert.equal(await redeemPreviewToken(backend, 'y'.repeat(32), token, host), null, 'wrong key');
  const cookie = signPreviewCookie(secret, {
    sandboxId: SANDBOX,
    userId: 'u',
    port: 3000,
    host: host.host
  });
  assert.ok(verifyPreviewCookie(secret, cookie, host));
  assert.equal(verifyPreviewCookie(secret, cookie, otherPort), null);
  assert.equal(verifyPreviewCookie(secret, `${cookie}x`, host), null);
  await backend.close();
});

test('previews never forward Orchard cookies and refuse cross-site requests', () => {
  assert.equal(
    forwardableCookies(`session_token=abc; ${PREVIEW_COOKIE}=sig; app=1; orchard_x=2`),
    'app=1'
  );
  const host = parsePreviewHost(`3000-${SANDBOX.slice(0, 8)}.preview.test`, 'preview.test')!;
  assert.equal(
    previewRequestAllowed({ origin: 'https://evil.test' }, host, 'preview.test', 'POST'),
    false
  );
  assert.equal(previewRequestAllowed({ origin: 'null' }, host, 'preview.test', 'POST'), false);
  assert.equal(
    previewRequestAllowed(
      { origin: `https://5173-${SANDBOX.slice(0, 8)}.preview.test` },
      host,
      'preview.test',
      'POST'
    ),
    true
  );
  assert.equal(
    previewRequestAllowed(
      { origin: 'https://3000-deadbeef.preview.test' },
      host,
      'preview.test',
      'POST'
    ),
    false,
    'another sandbox on the preview domain is cross-site'
  );
  assert.equal(
    previewRequestAllowed(
      {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document'
      },
      host,
      'preview.test',
      'GET'
    ),
    true
  );
  assert.equal(
    previewRequestAllowed(
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
      host,
      'preview.test',
      'GET'
    ),
    false
  );
});

test('the preview domain cannot share cookies with Orchard', () => {
  const env = { cookieDomain: '.orchard.my', frontendUrl: 'https://app.orchard.my' };
  assert.ok(previewDomainConflict('orchard.my', env));
  assert.ok(previewDomainConflict('preview.orchard.my', env));
  assert.ok(previewDomainConflict('my', { frontendUrl: 'https://app.orchard.my' }));
  assert.equal(previewDomainConflict('orchard-preview.dev', env), null);
  assert.ok(previewDomainConflict('not a domain', env));
});

test('prompts are recognised and server message ids match the opencode format', () => {
  assert.deepEqual(opencodePromptTarget('POST', 'session/ses_abc/prompt_async'), {
    chatId: 'ses_abc',
    kind: 'prompt_async'
  });
  assert.equal(opencodePromptTarget('GET', 'session/ses_abc/message'), null);
  assert.equal(opencodePromptTarget('POST', 'session/ses_abc/abort'), null);
  assert.deepEqual(opencodePromptTarget('POST', 'session/ses_abc/command?directory=%2Fx'), {
    chatId: 'ses_abc',
    kind: 'command'
  });
  assert.equal(opencodePromptTarget('POST', 'session/ses_abc/summarize'), null);
  assert.equal(opencodePromptTarget('POST', 'session/ses_abc/revert'), null);
  const a = newOpencodeMessageId();
  const b = newOpencodeMessageId();
  assert.match(a, OPENCODE_MESSAGE_ID_RE);
  assert.ok(a < b, 'ids sort by creation');
});

test('a session needs attention only when it stops working', () => {
  assert.equal(needsAttention('working', 'idle'), true);
  assert.equal(needsAttention(undefined, 'idle'), false);
  assert.equal(needsAttention('idle', 'idle'), false);
  assert.equal(needsAttention('idle', 'working'), false);
});

test('a connection cannot pile up unprocessed frames while one is slow', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: number[] = [];
  const queue = new FrameQueue(3);
  assert.equal(
    queue.push(() => gate.then(() => seen.push(1))),
    true
  );
  assert.equal(
    queue.push(async () => seen.push(2)),
    true
  );
  assert.equal(
    queue.push(async () => seen.push(3)),
    true
  );
  assert.equal(
    queue.push(async () => seen.push(4)),
    false
  );
  release();
  await queue.idle();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(
    queue.push(async () => seen.push(5)),
    true
  );
  await queue.idle();
  assert.deepEqual(seen, [1, 2, 3, 5]);
});

test('answers to agent permissions and questions are recognised for attribution', () => {
  assert.deepEqual(opencodeReplyTarget('POST', 'permission/per_abc/reply?directory=%2Fx'), {
    requestId: 'per_abc',
    kind: 'permission'
  });
  assert.deepEqual(opencodeReplyTarget('POST', 'session/ses_a/permissions/per_old'), {
    requestId: 'per_old',
    kind: 'permission'
  });
  assert.deepEqual(opencodeReplyTarget('POST', 'question/que_1/reply'), {
    requestId: 'que_1',
    kind: 'question'
  });
  assert.deepEqual(opencodeReplyTarget('POST', 'question/que_1/reject'), {
    requestId: 'que_1',
    kind: 'question'
  });
  assert.equal(opencodeReplyTarget('GET', 'permission/per_abc/reply'), null);
  assert.equal(opencodeReplyTarget('POST', 'permission'), null);
  assert.equal(opencodeReplyTarget('POST', 'permission//per_abc/reply'), null);
  assert.equal(opencodeReplyTarget('POST', 'permission/per_abc/../reply'), null);
  assert.equal(opencodeReplyTarget('POST', 'permission/per{a}/reply'), null);
  assert.equal(opencodeReplyTarget('POST', 'session/ses_a/prompt_async'), null);
});
