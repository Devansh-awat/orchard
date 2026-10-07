import test from 'node:test';
import assert from 'node:assert/strict';
import { Terminal } from '@xterm/headless';
import { SNAPSHOT_MAX_BYTES, SessionScreen } from '../src/kubernetes/exec-screen';

async function render(snapshot: string, cols: number, rows: number) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  await new Promise<void>((resolve) => term.write(snapshot, resolve));
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  const out = { lines, cursor: [b.cursorX, b.cursorY], alt: b.type === 'alternate' };
  term.dispose();
  return out;
}

test('a snapshot reproduces the screen, the cursor, and colours on a fresh terminal', async () => {
  const screen = new SessionScreen(40, 6);
  screen.write(Buffer.from('$ echo hi\r\nhi\r\n\x1b[32m$ \x1b[0mpsql'));
  const snap = await screen.snapshot();
  assert.equal(snap.truncated, false);
  const shown = await render(snap.data, 40, 6);
  assert.deepEqual(shown.lines.slice(0, 3), ['$ echo hi', 'hi', '$ psql']);
  assert.deepEqual(shown.cursor, [6, 2]);
  assert.ok(snap.data.includes('\x1b[32m'));
  screen.dispose();
});

test('a resize before the snapshot reflows the stored screen to the new size', async () => {
  const screen = new SessionScreen(80, 5);
  screen.write('x'.repeat(100) + '\r\n$ ');
  screen.resize(40, 5);
  assert.deepEqual([screen.cols, screen.rows], [40, 5]);
  const snap = await screen.snapshot();
  const shown = await render(snap.data, 40, 5);
  assert.ok(shown.lines.some((l) => l === 'x'.repeat(40)));
  assert.equal(shown.lines.at(-1)?.trimEnd() ?? '', '');
  screen.dispose();
});

test('the alternate screen is captured and restored as the alternate screen', async () => {
  const screen = new SessionScreen(40, 5);
  screen.write('normal\r\n\x1b[?1049h\x1b[H\x1b[2Jvim says hi');
  const snap = await screen.snapshot();
  const shown = await render(snap.data, 40, 5);
  assert.equal(shown.alt, true);
  assert.equal(shown.lines[0], 'vim says hi');
  screen.dispose();
});

test('an oversized scrollback falls back to the visible screen and says so', async () => {
  const screen = new SessionScreen(200, 50, 5000);
  const line = `${'x'.repeat(190)}\r\n`;
  const chunks = Math.ceil((SNAPSHOT_MAX_BYTES * 1.5) / line.length);
  for (let i = 0; i < chunks; i++) screen.write(line);
  const snap = await screen.snapshot();
  assert.equal(snap.truncated, true);
  assert.ok(Buffer.byteLength(snap.data, 'utf8') <= SNAPSHOT_MAX_BYTES);
  screen.dispose();
});

test('fifty busy screens stay inside a few megabytes each', async () => {
  const before = process.memoryUsage().heapUsed;
  const screens: SessionScreen[] = [];
  for (let s = 0; s < 50; s++) {
    const screen = new SessionScreen(200, 50);
    for (let i = 0; i < 550; i++) screen.write(`${s}:${i} ${'y'.repeat(150)}\r\n`);
    screens.push(screen);
  }
  await screens[0].snapshot();
  const perScreen = (process.memoryUsage().heapUsed - before) / screens.length;
  for (const screen of screens) screen.dispose();
  assert.ok(
    perScreen < 4 * 1024 * 1024,
    `per-screen heap ${(perScreen / 1024 / 1024).toFixed(1)} MiB`
  );
});

test('writes after dispose are dropped and the snapshot is empty', async () => {
  const screen = new SessionScreen(10, 2);
  screen.dispose();
  screen.write('ignored');
  assert.deepEqual(await screen.snapshot(), { data: '', truncated: false });
});
