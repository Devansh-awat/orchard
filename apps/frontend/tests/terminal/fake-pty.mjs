import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const port = Number(process.env.FAKE_PTY_PORT ?? 7681);
const wss = new WebSocketServer({ port, path: '/pty' });
const encoder = new TextEncoder();

const state = { resizes: [], connections: 0 };
const screens = new Map();

function screenFor(handle, cols, rows) {
	let entry = screens.get(handle);
	if (!entry) {
		const term = new Terminal({ cols, rows, scrollback: 500, allowProposedApi: true });
		const serializer = new SerializeAddon();
		term.loadAddon(serializer);
		entry = { term, serializer };
		screens.set(handle, entry);
	}
	return entry;
}

const delayMs = Number(process.env.FAKE_PTY_DELAY_MS ?? 0);

function send(ws, text) {
	const push = () => {
		ws.screen?.term.write(text);
		if (ws.readyState === ws.OPEN) ws.send(encoder.encode(text), { binary: true });
	};
	if (delayMs > 0) setTimeout(push, delayMs);
	else push();
}

wss.on('connection', (ws, req) => {
	state.connections += 1;
	const url = new URL(req.url, 'http://localhost');
	const requested = url.searchParams.get('session');
	const proto = url.searchParams.get('proto') === '2' ? 2 : 1;
	const cols = Number(url.searchParams.get('cols') ?? 80) || 80;
	const rows = Number(url.searchParams.get('rows') ?? 24) || 24;
	const resumed = Boolean(requested && screens.has(requested));
	const handle = resumed ? requested : 'v1.fake.' + state.connections;
	const screen = screenFor(handle, cols, rows);
	ws.screen = screen;
	if (screen.term.cols !== cols || screen.term.rows !== rows) screen.term.resize(cols, rows);
	let line = '';
	const attach = () => {
		if (proto === 2) {
			ws.send(
				JSON.stringify({
					type: 'attached',
					proto: 2,
					handle,
					resumed,
					reason: resumed ? 'resumed' : 'new',
					reusedId: false,
					cols,
					rows,
					snapshot: resumed ? screen.serializer.serialize({ scrollback: 500 }) : undefined,
					truncated: false
				})
			);
		} else {
			ws.send(
				JSON.stringify({
					type: 'attached',
					handle,
					resumed,
					reason: resumed ? 'resumed' : 'new',
					replayedBytes: 0,
					truncated: false
				})
			);
		}
		console.log(`attached proto=${proto} ${cols}x${rows}${resumed ? ' (resumed)' : ''}`);
		if (!resumed) send(ws, 'fake pty ready\r\n$ ');
	};
	screen.term.write('', attach);

	ws.on('message', (data, isBinary) => {
		if (!isBinary) {
			let frame = null;
			try {
				frame = JSON.parse(data.toString());
			} catch {
				frame = null;
			}
			if (frame?.type === 'resize') {
				state.resizes.push({
					cols: frame.cols,
					rows: frame.rows,
					force: !!frame.force,
					at: Date.now()
				});
				console.log(`resize ${frame.cols}x${frame.rows}${frame.force ? ' (force)' : ''}`);
				return;
			}
			return;
		}
		const text = data.toString('utf8');
		for (const ch of text) {
			if (ch === '\r') {
				const cmd = line.trim();
				line = '';
				send(ws, '\r\n');
				if (cmd === 'drop') {
					ws.terminate();
					return;
				}
				if (cmd === 'big') {
					let out = '';
					for (let i = 1; i <= 2000; i++) out += `line ${i}\r\n`;
					send(ws, out);
				} else if (cmd === 'alt') {
					send(ws, '\x1b[?1049h\x1b[H\x1b[2Jalternate screen, press q\r\n');
				} else if (cmd === 'size') {
					const last = state.resizes.at(-1);
					send(ws, last ? `pty is ${last.cols}x${last.rows}\r\n` : 'no resize yet\r\n');
				} else if (cmd === 'resizes') {
					send(ws, `${state.resizes.length} resize frames\r\n`);
				} else if (cmd) {
					send(ws, `you typed: ${cmd}\r\n`);
				}
				send(ws, '$ ');
			} else if (ch === '\x7f') {
				if (line.length) {
					line = line.slice(0, -1);
					send(ws, '\b \b');
				}
			} else if (ch === '\x0c') {
				send(ws, '\x1b[H\x1b[2J$ ' + line);
			} else if (ch >= ' ') {
				line += ch;
				send(ws, ch);
			}
		}
	});
	ws.on('close', () => console.log('closed'));
});

console.log(`fake pty listening on ws://localhost:${port}/pty`);
