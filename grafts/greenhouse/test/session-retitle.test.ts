import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxSessionsService } from '../server/src/sandboxes/sandbox-sessions.service';

function harness(initial: string) {
  const row = { id: 's1', sandboxId: 'box', title: initial, archivedAt: null };
  const emitted: string[] = [];
  const prisma = {
    sandboxConversation: {
      findFirst: async () => ({ id: row.id, title: row.title }),
      findUnique: async () => ({ ...row }),
      updateMany: async (args: any) => {
        if (args.where.title !== row.title) return { count: 0 };
        row.title = args.data.title;
        return { count: 1 };
      }
    }
  };
  const svc = new SandboxSessionsService(prisma as any, {} as any, {} as any, {} as any);
  (svc as any).decorate = async (_: unknown, rows: any[]) => rows.map((r) => ({ ...r }));
  svc.onSessionChanged((_: string, dto: any) => emitted.push(dto.title));
  return { svc, row, emitted };
}

const sandbox = { id: 'box', status: 'running' } as any;

test('the first prompt renames a session that still has its city name', async () => {
  const h = harness('Burlington');
  await h.svc.titleFromPrompt({ sandbox, sessionId: 's1', text: 'add a dark mode toggle' });
  assert.equal(h.row.title, 'Add a dark mode toggle');
  assert.deepEqual(h.emitted, ['Add a dark mode toggle']);
  await h.svc.titleFromPrompt({ sandbox, sessionId: 's1', text: 'now make it blue' });
  assert.equal(h.row.title, 'Add a dark mode toggle');
});

test('a session someone named is never renamed by a prompt', async () => {
  const h = harness('Fix login');
  await h.svc.titleFromPrompt({ sandbox, sessionId: 's1', text: 'something else entirely' });
  assert.equal(h.row.title, 'Fix login');
  assert.deepEqual(h.emitted, []);
});

test('a prompt sent from the resolved worktree path still finds its session', async () => {
  const h = harness('Stowe');
  let where: any = null;
  const find = (h.svc as any).prisma.sandboxConversation.findFirst;
  (h.svc as any).prisma.sandboxConversation.findFirst = async (args: any) => {
    where = args.where;
    return find(args);
  };
  await h.svc.titleFromPrompt({
    sandbox,
    chatId: 'ses_abc',
    directory: '/mnt/orchard-drive/home/.worktrees/homey/stowe-be9ba1',
    text: 'add a dark mode toggle'
  });
  assert.deepEqual(where.OR.at(-1), { repo: 'homey', slug: 'stowe-be9ba1' });
  assert.equal(h.row.title, 'Add a dark mode toggle');
});

test('the agent naming its chat after the city never undoes the prompt title', async () => {
  const h = harness('Burlington');
  (h.svc as any).workspace = {
    opencodeRequest: async () => ({ status: 200, body: { title: 'Burlington' } })
  };
  await h.svc.titleFromPrompt({
    sandbox,
    sessionId: 's1',
    chatId: 'ses_1',
    text: 'add a dark mode toggle',
    agentTitles: true
  });
  await new Promise((r) => setTimeout(r, 4_300));
  assert.equal(h.row.title, 'Add a dark mode toggle');
});

test('a title the agent writes for the chat replaces the prompt title', async () => {
  const h = harness('Burlington');
  (h.svc as any).workspace = {
    opencodeRequest: async () => ({ status: 200, body: { title: 'Dark mode toggle' } })
  };
  await h.svc.titleFromPrompt({
    sandbox,
    sessionId: 's1',
    chatId: 'ses_1',
    text: 'add a dark mode toggle to settings and remember it',
    agentTitles: true
  });
  await new Promise((r) => setTimeout(r, 4_300));
  assert.equal(h.row.title, 'Dark mode toggle');
  assert.deepEqual(h.emitted, [
    'Add a dark mode toggle to settings and remember it',
    'Dark mode toggle'
  ]);
});
