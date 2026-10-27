import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { freshId } from './ids.ts';
import { podsOf } from './routes/deployments.ts';
import type { Store } from './store.ts';

const EXEC = /^\/apiv1\/pods\/([^/]+)\/exec$/;

const FILES = [
	'Dockerfile',
	'README.md',
	'build',
	'node_modules',
	'package.json',
	'pnpm-lock.yaml',
	'src'
];

export function terminalServer(store: Store) {
	const wss = new WebSocketServer({ noServer: true });

	function session(ws: WebSocket, pod: string) {
		const d = store.state.deployments.find((x) => podsOf(store, x).some((p) => p.name === pod));
		const started = Date.now();
		const prompt = `\x1b[32mapp@${pod}\x1b[0m:\x1b[34m/app\x1b[0m$ `;
		let line = '';
		const out = (s: string) => ws.send(Buffer.from(s.replace(/\n/g, '\r\n')));

		const run = (input: string) => {
			const [cmd, ...args] = input.trim().split(/\s+/);
			switch (cmd) {
				case undefined:
				case '':
					return;
				case 'help':
					return out(
						'mock shell: ls, pwd, whoami, hostname, env, echo, date, uptime, ps, cat, clear, exit\n'
					);
				case 'ls':
					return out(`${FILES.join('  ')}\n`);
				case 'pwd':
					return out('/app\n');
				case 'whoami':
					return out('app\n');
				case 'hostname':
					return out(`${pod}\n`);
				case 'date':
					return out(`${new Date().toUTCString()}\n`);
				case 'echo':
					return out(`${args.join(' ')}\n`);
				case 'uptime':
					return out(
						` up ${Math.round((Date.now() - started) / 1000)}s,  load average: 0.08, 0.11, 0.09\n`
					);
				case 'ps':
					return out(
						'  PID USER     COMMAND\n    1 app      node build/index.js\n   42 app      sh\n'
					);
				case 'env':
					return out(
						`${(d?.envVars ?? [])
							.map((v) => `${v.key}=${v.secret ? '********' : v.value}`)
							.concat(['HOSTNAME=' + pod, 'HOME=/home/app'])
							.join('\n')}\n`
					);
				case 'cat':
					return args[0] === 'package.json'
						? out(
								`{\n  "name": "${d?.name ?? 'app'}",\n  "private": true,\n  "scripts": { "start": "node build" }\n}\n`
							)
						: out(`cat: ${args[0] ?? ''}: No such file or directory\n`);
				case 'clear':
					return out('\x1b[2J\x1b[H');
				default:
					return out(`sh: ${cmd}: command not found (this is the mock shell, try help)\n`);
			}
		};

		ws.send(
			JSON.stringify({
				type: 'attached',
				proto: 2,
				handle: freshId(),
				resumed: false,
				reason: 'new',
				truncated: false
			})
		);
		out(`\x1b[2mOrchard mock shell. Nothing here touches a cluster.\x1b[0m\n${prompt}`);

		ws.on('message', (data, isBinary) => {
			const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
			if (!isBinary && text.startsWith('{')) return;
			for (const ch of text) {
				if (ch === '\r' || ch === '\n') {
					out('\n');
					if (line.trim() === 'exit') {
						ws.close(1000, 'Session ended');
						return;
					}
					run(line);
					line = '';
					out(prompt);
				} else if (ch === '\x7f' || ch === '\b') {
					if (line.length) {
						line = line.slice(0, -1);
						out('\b \b');
					}
				} else if (ch === '\x03') {
					line = '';
					out(`^C\n${prompt}`);
				} else if (ch === '\x04' && !line) {
					ws.close(1000, 'Session ended');
					return;
				} else if (ch >= ' ') {
					line += ch;
					out(ch);
				}
			}
		});
	}

	return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? '/', 'http://mock');
		const m = EXEC.exec(url.pathname);
		if (!m || !store.state.signedIn) {
			socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => session(ws, decodeURIComponent(m[1])));
	};
}
