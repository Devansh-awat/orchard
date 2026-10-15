import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_LOGINS,
  findSignIn,
  isLocalCallback,
  parseLoginOutput,
  publicLogins
} from '../server/src/sandboxes/daemon/agent-logins';

test('codex device sign-in yields its link and one-time code', () => {
  const raw =
    'Welcome to Codex\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n' +
    '1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n' +
    '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mABCD-EFGHI\x1b[0m\r\n';
  const parsed = parseLoginOutput(raw);
  assert.equal(parsed.url, 'https://auth.openai.com/codex/device');
  assert.equal(parsed.code, 'ABCD-EFGHI');
  assert.equal(parsed.token, null);
  assert.ok(parsed.lines.every((l) => !l.includes('\x1b')));
});

test('a code inside the link is not mistaken for the shown code', () => {
  const parsed = parseLoginOutput(
    'Open https://vercel.com/device?user_code=WXYZ-1234\nCode: WXYZ-1234\n\nWaiting for authentication.'
  );
  assert.equal(parsed.url, 'https://vercel.com/device?user_code=WXYZ-1234');
  assert.equal(parsed.code, 'WXYZ-1234');
});

test('localhost callback addresses are never offered as the link to open', () => {
  const parsed = parseLoginOutput(
    'Listening on http://localhost:1455/auth/callback\nOpen this URL to sign in with Codex:\n' +
      'https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'
  );
  assert.match(parsed.url ?? '', /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
});

test('the claude token is captured and redacted from what the browser sees', () => {
  const token = 'sk-ant-oat01-' + 'a'.repeat(90);
  const raw =
    '\x1b[2K\x1b[1A\x1b[2K\x1b[G✓ Long-lived authentication token created successfully!\r\n\r\n' +
    `Your OAuth token (valid for 1 year):\r\n\r\n\x1b[1m${token}\x1b[22m\r\n\r\nStore this token securely.\r\n`;
  const parsed = parseLoginOutput(raw);
  assert.equal(parsed.token, token);
  assert.ok(parsed.lines.every((l) => !l.includes(token)));
  assert.ok(parsed.lines.some((l) => l.includes('sk-ant-oat01-••••')));
});

test('carriage-return redraws keep only the final line', () => {
  const parsed = parseLoginOutput('Waiting.\rWaiting..\rWaiting...\nDone\n');
  assert.deepEqual(parsed.lines, ['Waiting...', 'Done']);
});

test('pasted localhost addresses route to the callback, codes go to the prompt', () => {
  assert.equal(isLocalCallback('http://localhost:1455/auth/callback?code=x&state=y'), true);
  assert.equal(isLocalCallback('  http://127.0.0.1:43123/cb?code=x '), true);
  assert.equal(isLocalCallback('abc123#state'), false);
  assert.equal(isLocalCallback('https://evil.test/localhost'), false);
});

test('sign-in commands are fixed on the server and never sent to browsers', () => {
  assert.deepEqual(findSignIn('claude', 'subscription')?.command, ['claude', 'setup-token']);
  assert.equal(findSignIn('claude', 'token'), null);
  assert.equal(findSignIn('nope', 'subscription'), null);
  assert.ok(!JSON.stringify(publicLogins()).includes('"command"'));
  for (const info of AGENT_LOGINS) {
    assert.equal(new Set(info.methods.map((m) => m.id)).size, info.methods.length);
  }
});
