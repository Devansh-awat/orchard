import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createServer } from 'https';
import { gitCloneScript } from '../src/docker/clone-script';
import { parseRepoUrl, withCloneCredentials } from '../src/docker/repo-url';

const TOKEN_KINDS = ['ghs', 'ghu', 'gho', 'ghp', 'github_pat'];

function isToken(value: string, secret: string): boolean {
  return TOKEN_KINDS.some((kind) => value === `${kind}_${secret}`);
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  const user = split === -1 ? decoded : decoded.slice(0, split);
  const pass = split === -1 ? '' : decoded.slice(split + 1);
  return isToken(user, secret) || isToken(pass, secret);
}

function serve(root: string, secret: string, cert: string, key: string, port: number) {
  createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://github.com');
    const ok = authorized(req.headers.authorization, secret);
    process.stdout.write(
      `${req.method} ${url.pathname}${url.search} auth=${req.headers.authorization ? 'sent' : 'none'} ${ok ? 'ok' : 'denied'}\n`
    );
    if (!ok) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
      res.end();
      return;
    }
    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        REMOTE_USER: 'e2e',
        REMOTE_ADDR: req.socket.remoteAddress ?? ''
      }
    });
    req.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const sep = line.indexOf(':');
        const name = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.writeHead(status);
      headersSent = true;
      res.write(head.subarray(end + 4));
    });
    backend.stderr.pipe(process.stderr);
    backend.on('close', () => res.end());
  }).listen(port, '0.0.0.0', () => process.stdout.write(`listening on ${port}\n`));
}

const [command, ...args] = process.argv.slice(2);
if (command === 'serve') {
  const [root, secret, cert, key, port = '443'] = args;
  serve(root, secret, cert, key, Number(port));
} else if (command === 'script') {
  process.stdout.write(gitCloneScript(args[0] ?? 'main'));
} else if (command === 'url') {
  process.stdout.write(withCloneCredentials(parseRepoUrl(args[0])!, args[1]));
} else {
  process.stderr.write('usage: clone-e2e serve|script|url\n');
  process.exit(1);
}
