import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLiveBackend, MemoryLiveNetwork } from '../src/sandboxes/live/live-backend';
import { LiveSocket, SandboxLiveHub } from '../src/sandboxes/live/live-hub';
import { FrameQueue } from '../src/sandboxes/live/live-protocol';
import { YRoomFiles, YRoomManager, contentHash } from '../src/sandboxes/live/yjs-rooms';
import { applyEdits, diffText, mergeText } from '../src/sandboxes/live/text-diff';
import * as clientDiff from '../../frontend/src/lib/components/sandbox/editor/text-diff';
import { YjsRoom } from '../../frontend/src/lib/components/sandbox/editor/yjs-room';
import { normalizeRelativePath } from '../src/sandboxes/sandbox-session-commands';
import type { SandboxRole } from '../src/sandboxes/sandbox-access.service';

const SANDBOX = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const PATH = 'src/app.ts';
const ROOM = `file:${SID}:${PATH}`;

const TIMINGS = {
  saveDebounceMs: 30,
  pollMs: 40,
  emptyTtlMs: 60_000,
  ownerTtlMs: 300,
  ownerHeartbeatMs: 60,
  subscriberTtlMs: 10_000,
  ownerCacheMs: 40,
  adoptGraceMs: 150
};

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

class LoopSocket implements LiveSocket {
  readyState = 1;

  bufferedAmount = 0;

  constructor(private readonly deliver: (frame: Record<string, unknown>) => void) {}

  send(data: string) {
    const frame = JSON.parse(data);
    setImmediate(() => {
      if (this.readyState === 1) this.deliver(frame);
    });
  }

  close() {
    this.readyState = 3;
  }
}

interface Replica {
  id: string;
  backend: MemoryLiveBackend;
  hub: SandboxLiveHub;
  rooms: YRoomManager;
  crashed: boolean;
}

interface Client {
  userId: string;
  room: YjsRoom;
  replica: Replica;
  online: boolean;
  queue: FrameQueue;
  connect(replica?: Replica): void;
  disconnect(): Promise<void>;
  type(index: number, text: string): void;
  erase(index: number, length: number): void;
  text(): string;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function cluster(initial: string, roles: Record<string, SandboxRole>) {
  const network = new MemoryLiveNetwork();
  const files = new MemoryFiles();
  files.files.set(PATH, initial);
  const replicas: Replica[] = [];
  const clients: Client[] = [];

  function replica(id: string): Replica {
    const backend = new MemoryLiveBackend(network, id);
    const holder: { hub: SandboxLiveHub | null } = { hub: null };
    const rooms = new YRoomManager(
      backend,
      {
        replicaId: id,
        deliverLocal: (connId, frame) => holder.hub?.deliverLocal(connId, frame),
        publish: (sandboxId, envelope) => holder.hub!.publishY(sandboxId, envelope)
      },
      files,
      TIMINGS
    );
    const hub = new SandboxLiveHub({
      backend,
      rooms,
      resolveRole: async (_s, userId) => roles[userId] ?? null,
      validateSession: async () => true,
      sessionBelongs: async (_s, sid) => sid === SID,
      postComment: async () => ({}),
      normalizePath: normalizeRelativePath,
      recheckMs: 60_000
    });
    holder.hub = hub;
    const made = { id, backend, hub, rooms, crashed: false };
    replicas.push(made);
    return made;
  }

  function client(userId: string, at: Replica, options: { canWrite?: boolean } = {}): Client {
    let conn: ReturnType<SandboxLiveHub['attach']> | null = null;
    let socket: LoopSocket | null = null;
    const self: Client = {
      userId,
      replica: at,
      online: false,
      queue: new FrameQueue(),
      room: new YjsRoom(
        ROOM,
        (frame) => {
          if (!self.online || !conn) return false;
          const target = conn;
          const hub = self.replica.hub;
          self.queue.push(() => hub.handleMessage(target, JSON.stringify(frame)));
          return true;
        },
        {
          canWrite: options.canWrite ?? roles[userId] !== 'viewer',
          selfId: userId,
          ackTimeoutMs: 400
        }
      ),
      connect(next?: Replica) {
        if (next) self.replica = next;
        const current = new LoopSocket((frame) => self.room.receive(frame as any));
        socket = current;
        conn = self.replica.hub.attach({
          sandboxId: SANDBOX,
          userId,
          sessionId: null,
          orgScope: null,
          user: { id: userId, name: userId, avatarUrl: null },
          role: roles[userId],
          sid: SID,
          socket: current
        });
        self.online = true;
        self.room.connect();
      },
      async disconnect() {
        self.online = false;
        socket?.close();
        const old = conn;
        conn = null;
        self.room.disconnect();
        if (old) await self.replica.hub.detach(old);
      },
      type(index: number, text: string) {
        self.room.doc.transact(() => self.room.text.insert(index, text), self.room.local);
      },
      erase(index: number, length: number) {
        self.room.doc.transact(() => self.room.text.delete(index, length), self.room.local);
      },
      text() {
        return self.room.text.toString();
      }
    };
    clients.push(self);
    self.connect();
    return self;
  }

  function roomText(): string | null {
    for (const r of replicas) {
      if (r.crashed) continue;
      const text = r.rooms.roomText(ROOM);
      if (text !== null) return text;
    }
    return null;
  }

  async function settle(timeoutMs = 5000) {
    const started = Date.now();
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
      await wait(15);
      for (const c of clients) if (c.online) c.room.tick();
      const server = roomText();
      const online = clients.filter((c) => c.online);
      const quiet = online.every(
        (c) => c.room.status === 'synced' && c.room.pendingCount === 0 && c.text() === server
      );
      stable = quiet ? stable + 1 : 0;
      if (stable >= 4) return;
    }
    const states = clients.map((c) => ({
      user: c.userId,
      online: c.online,
      status: c.room.status,
      pending: c.room.pendingCount,
      text: c.text()
    }));
    assert.fail(`did not converge: server=${JSON.stringify(roomText())} ${JSON.stringify(states)}`);
  }

  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    for (const c of clients) c.room.destroy();
    for (const r of replicas) {
      await r.hub.close().catch(() => {});
      await r.rooms.close().catch(() => {});
      await r.backend.close().catch(() => {});
    }
  }

  function owners(): string[] {
    return replicas.filter((r) => r.rooms.ownedRooms().includes(ROOM)).map((r) => r.id);
  }

  open.push(close);
  return { files, replica, client, settle, close, roomText, owners, replicas };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('the multi-hunk diff touches only what changed and both copies agree', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}\n`);
  const a = lines.join('');
  const b = ['LINE 0 changed\n', ...lines.slice(1, 399), 'line 399 changed\n'].join('');
  const edits = diffText(a, b);
  assert.equal(edits.length, 2);
  assert.ok(edits.every((e) => e.remove < 20));
  assert.equal(applyEdits(a, edits), b);
  assert.deepEqual(clientDiff.diffText(a, b), edits);
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    let x = a;
    for (let k = 0; k < 1 + rand(6); k++) {
      const at = rand(x.length + 1);
      x =
        rand(2) === 0
          ? x.slice(0, at) + `+${rand(1000)}\n` + x.slice(at)
          : x.slice(0, at) + x.slice(Math.min(x.length, at + rand(30)));
    }
    assert.equal(applyEdits(a, diffText(a, x)), x);
    assert.deepEqual(clientDiff.diffText(a, x), diffText(a, x));
  }
  assert.equal(mergeText('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n'), 'a\nB\nC\n');
  assert.equal(mergeText('a\nb\n', 'a\nX\n', 'a\nX\n'), 'a\nX\n');
  assert.equal(mergeText('a\nb\n', 'a\nmine\n', 'a\ntheirs\n'), 'a\nmine\n');
});

test('two people typing on the same line converge to one text', async () => {
  const c = cluster('const a = 1;\n', { u1: 'owner', u2: 'collaborator' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  const two = c.client('u2', a);
  await c.settle();
  one.type(12, ' // one');
  two.type(12, ' // two');
  one.type(0, 'export ');
  two.erase(6, 1);
  await c.settle();
  const text = one.text();
  assert.equal(text, two.text());
  assert.equal(text, c.roomText());
  assert.equal(count(text, '// one'), 1);
  assert.equal(count(text, '// two'), 1);
  assert.ok(text.startsWith('export const'));
  await c.close();
});

test('interleaved inserts and deletes from three people converge', async () => {
  const c = cluster('0123456789\n'.repeat(20), {
    u1: 'owner',
    u2: 'collaborator',
    u3: 'collaborator'
  });
  const a = c.replica('replica-a');
  const people = [c.client('u1', a), c.client('u2', a), c.client('u3', a)];
  await c.settle();
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 12; round++) {
    for (let op = 0; op < 15; op++) {
      const who = people[rand(people.length)];
      const length = who.text().length;
      if (rand(3) === 0 && length > 0) {
        const at = rand(length);
        who.erase(at, Math.min(1 + rand(5), length - at));
      } else {
        who.type(rand(length + 1), `<${who.userId}${round}.${op}>`);
      }
    }
    if (round % 3 === 2) await c.settle();
    else await wait(rand(10));
  }
  await c.settle();
  const text = people[0].text();
  for (const p of people) assert.equal(p.text(), text);
  assert.equal(c.roomText(), text);
  await c.close();
});

test('an agent write on disk merges as a diff while both people keep typing', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `row ${i}\n`).join('');
  const c = cluster(lines, { u1: 'owner', u2: 'collaborator' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  const two = c.client('u2', a);
  await c.settle();
  one.type(0, '// top\n');
  two.type(two.text().indexOf('row 25'), 'mid ');
  c.files.files.set(PATH, lines.replace('row 49\n', 'row 49 by agent\n'));
  one.type(one.text().indexOf('row 10'), 'ten ');
  await c.settle();
  await wait(200);
  await c.settle();
  const text = one.text();
  assert.equal(text, two.text());
  assert.equal(count(text, '// top'), 1);
  assert.equal(count(text, 'mid row 25'), 1);
  assert.equal(count(text, 'ten row 10'), 1);
  assert.equal(count(text, 'row 49 by agent'), 1);
  assert.equal(count(text, 'row 3\n'), 1);
  assert.equal(c.files.files.get(PATH), text);
  await c.close();
});

test('the room never re-applies its own save as an outside edit', async () => {
  const c = cluster('hello\n', { u1: 'owner' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  await c.settle();
  one.type(5, ' world');
  await c.settle();
  await wait(200);
  await c.settle();
  assert.equal(c.files.files.get(PATH), 'hello world\n');
  assert.equal(one.text(), 'hello world\n');
  const writes = c.files.writes;
  await wait(200);
  assert.equal(c.files.writes, writes);
  await c.close();
});

test('someone who drops off keeps editing and merges on reconnect without a reload', async () => {
  const c = cluster('alpha\nbeta\ngamma\n', { u1: 'owner', u2: 'collaborator' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  const two = c.client('u2', a);
  await c.settle();
  await two.disconnect();
  assert.equal(two.room.status, 'reconnecting');
  one.type(0, 'online ');
  two.type(two.text().length, 'offline\n');
  assert.equal(two.room.status, 'offline');
  await c.settle();
  assert.ok(!one.text().includes('offline'));
  two.connect();
  await c.settle();
  assert.equal(one.text(), two.text());
  assert.equal(count(one.text(), 'online alpha'), 1);
  assert.equal(count(one.text(), 'offline\n'), 1);
  await c.close();
});

test('a viewer cannot change the shared doc even with a tampered client', async () => {
  const c = cluster('safe\n', { u1: 'owner', v: 'viewer' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  const viewer = c.client('v', a, { canWrite: true });
  await c.settle(2000).catch(() => {});
  viewer.type(0, 'evil ');
  await wait(100);
  assert.equal(c.roomText(), 'safe\n');
  assert.equal(viewer.room.canWrite, false);
  one.type(0, 'owner ');
  await wait(150);
  assert.equal(c.roomText(), 'owner safe\n');
  assert.ok(viewer.text().includes('owner '));
  assert.ok(!(c.files.files.get(PATH) ?? '').includes('evil'));
  await c.close();
});

test('people on two replicas edit one doc held by a single owner', async () => {
  const c = cluster('shared\n', { u1: 'owner', u2: 'collaborator' });
  const a = c.replica('replica-a');
  const b = c.replica('replica-b');
  const one = c.client('u1', a);
  await c.settle();
  const two = c.client('u2', b);
  await c.settle();
  one.type(0, 'A');
  two.type(two.text().length, 'B\n');
  await c.settle();
  assert.equal(one.text(), 'Ashared\nB\n');
  assert.equal(two.text(), one.text());
  assert.deepEqual(c.owners(), ['replica-a']);
  await c.close();
});

test('undo only takes back your own typing', async () => {
  const c = cluster('', { u1: 'owner', u2: 'collaborator' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  const two = c.client('u2', a);
  await c.settle();
  one.type(0, 'mine ');
  one.room.undo.stopCapturing();
  await c.settle();
  two.type(two.text().length, 'yours ');
  await c.settle();
  one.type(one.text().length, 'again');
  one.room.undo.stopCapturing();
  await c.settle();
  one.room.undo.undo();
  await c.settle();
  assert.equal(one.text(), 'mine yours ');
  one.room.undo.undo();
  await c.settle();
  assert.equal(two.text(), 'yours ');
  one.room.undo.redo();
  await c.settle();
  assert.equal(two.text(), 'mine yours ');
  await c.close();
});

test('a crashed owner hands the doc to the next replica without losing unsaved edits', async () => {
  const c = cluster('base\n', { u1: 'owner', u2: 'collaborator' });
  const a = c.replica('replica-a');
  const b = c.replica('replica-b');
  const one = c.client('u1', a);
  await c.settle();
  const two = c.client('u2', b);
  await c.settle();
  assert.deepEqual(c.owners(), ['replica-a']);
  one.type(0, 'first ');
  await c.settle();
  const crashed = a.rooms as unknown as { timer: NodeJS.Timeout; heartbeat: NodeJS.Timeout };
  clearInterval(crashed.timer);
  clearInterval(crashed.heartbeat);
  a.crashed = true;
  await a.backend.close();
  one.online = false;
  one.room.disconnect();
  two.type(two.text().length, 'second\n');
  one.type(one.text().length, 'third\n');
  await wait(600);
  one.connect(b);
  await c.settle(8000);
  const text = one.text();
  assert.equal(two.text(), text);
  assert.equal(count(text, 'first '), 1);
  assert.equal(count(text, 'second\n'), 1);
  assert.equal(count(text, 'third\n'), 1);
  assert.equal(count(text, 'base'), 1);
  assert.equal(c.roomText(), text);
  assert.deepEqual(
    c.owners().filter((id) => id !== 'replica-a'),
    ['replica-b']
  );
  await wait(200);
  assert.equal(c.files.files.get(PATH), text);
  await c.close();
});

test('a late rejoin after the doc moved on merges its edits as text', async () => {
  const c = cluster('one\ntwo\nthree\n', { u1: 'owner', u2: 'collaborator', u3: 'collaborator' });
  const a = c.replica('replica-a');
  const one = c.client('u1', a);
  await c.settle();
  await wait(100);
  const lost = a.rooms as unknown as {
    rooms: Map<string, unknown>;
    destroy(owned: unknown, flush: boolean): Promise<void>;
  };
  await one.disconnect();
  one.type(0, 'zero\n');
  await lost.destroy(lost.rooms.get(ROOM), false);
  const fresh = c.client('u3', a);
  await wait(300);
  fresh.type(fresh.text().length, 'four\n');
  await c.settle();
  one.connect();
  await c.settle();
  assert.equal(one.text(), fresh.text());
  assert.equal(one.text(), 'zero\none\ntwo\nthree\nfour\n');
  await c.close();
});
