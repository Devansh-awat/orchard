import * as http from 'http';
import * as WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { jwtVerify } from 'jose';
import { PassThrough } from 'stream';

/**
 * Raw WebSocket server for interactive pod terminals.
 * Handles: ws(s)://host/apiv1/pods/:podName/exec?namespace=...&container=...
 *
 * Auth: reads `session_token` cookie and verifies JWT.
 * Pipes stdin/stdout/stderr between the browser and `kubectl exec`.
 */
export function attachTerminalWebSocket(server: http.Server) {
  const wss = new WebSocket.Server({ noServer: true });

  const kc = new k8s.KubeConfig();
  const base64Value = process.env.KUBECONFIG_BASE64;
  const configPath = process.env.KUBECONFIG_PATH || process.env.KUBECONFIG;

  if (base64Value) {
    kc.loadFromString(Buffer.from(base64Value, 'base64').toString('utf-8'));
  } else if (configPath) {
    // Try base64 first, then file
    try {
      const decoded = Buffer.from(configPath, 'base64').toString('utf-8');
      if (decoded.includes('apiVersion') || decoded.includes('clusters')) {
        kc.loadFromString(decoded);
      } else {
        kc.loadFromFile(configPath);
      }
    } catch {
      kc.loadFromFile(configPath);
    }
  } else {
    kc.loadFromDefault();
  }

  const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET || '');

  server.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/apiv1\/pods\/([^/]+)\/exec$/);
    if (!match) return; // Not our route — let other handlers deal with it

    // Auth: parse session_token from cookies
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies['session_token'];
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      await jwtVerify(token, jwtSecret);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const podName = match[1];
    const namespace = url.searchParams.get('namespace') || 'default';
    const container = url.searchParams.get('container') || '';

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      handleExecSession(ws, kc, namespace, podName, container);
    });
  });
}

function handleExecSession(
  ws: WebSocket,
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  container: string,
) {
  const exec = new k8s.Exec(kc);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Forward stdout → ws
  stdout.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  // Forward stderr → ws
  stderr.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  // Forward ws messages → stdin
  ws.on('message', (data: WebSocket.Data) => {
    const msg = typeof data === 'string' ? data : data.toString();

    // Handle resize messages: JSON with type "resize"
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize') {
        // k8s exec doesn't support resize on non-tty streams easily,
        // but the resize is handled by the terminal emulator client-side
        return;
      }
    } catch {
      // Not JSON — treat as terminal input
    }

    stdin.write(msg);
  });

  let execClosed = false;

  ws.on('close', () => {
    execClosed = true;
    stdin.end();
  });

  ws.on('error', () => {
    execClosed = true;
    stdin.end();
  });

  // Determine shell: try /bin/bash, fall back to /bin/sh
  const command = ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];

  exec.exec(
    namespace,
    podName,
    container,
    command,
    stdout,
    stderr,
    stdin,
    true, // tty
    (status) => {
      if (!execClosed && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, status.status === 'Success' ? 'exited' : `exec failed: ${status.message}`);
      }
    },
  ).catch((err) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\r\nError: ${err.message}\r\n`);
      ws.close(1011, 'exec error');
    }
  });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}
