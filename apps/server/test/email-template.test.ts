import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fillTemplate } from '../src/email/render-template';

/**
 * The markers in the MJML templates are data a formatter is happy to reflow.
 * One did: `{{otpCode}}` became `{{ otpCode }}`, the literal match stopped
 * matching, and the sign-in mail went out with the marker where the code should
 * have been. These pin the contract that made that possible.
 */

const TEMPLATES = path.join(__dirname, '../src/email/templates');

test('a marker is filled whether or not the braces are padded', () => {
  const { output, unresolved } = fillTemplate('a {{otpCode}} b {{ otpCode }} c {{  otpCode  }}', {
    otpCode: '123456'
  });
  assert.equal(output, 'a 123456 b 123456 c 123456');
  assert.deepEqual(unresolved, []);
});

test('a marker with no value is reported rather than posted to someone', () => {
  const { output, unresolved } = fillTemplate('code {{ otpCode }} for {{ recipientEmail }}', {
    otpCode: '123456'
  });
  assert.equal(output, 'code 123456 for {{ recipientEmail }}');
  assert.deepEqual(unresolved, ['recipientEmail']);
});

test('text that is not a marker is left alone', () => {
  const source = 'a { b } c {{ }} d {{ 9lives }} e ${notThis}';
  assert.equal(fillTemplate(source, { b: 'x' }).output, source);
});

// Every template the server ships, rendered with the variables its callers
// pass. Nothing may survive into an email a person reads.
const CALLERS: Record<string, string[]> = {
  otp: ['recipientEmail', 'otpCode', 'expiryMinutes', 'frontendUrl'],
  notification: ['title', 'body', 'contextLine', 'ctaUrl', 'frontendUrl'],
  'organization-invite': [
    'recipientEmail',
    'recipientName',
    'organizationName',
    'inviterName',
    'role',
    'loginUrl',
    'frontendUrl'
  ],
  'project-invite': [
    'recipientEmail',
    'recipientName',
    'organizationName',
    'projectName',
    'inviterName',
    'role',
    'loginUrl',
    'frontendUrl'
  ],
  'workspace-invite': [
    'recipientEmail',
    'recipientName',
    'workspaceName',
    'organizationName',
    'inviterName',
    'role',
    'inviteUrl',
    'frontendUrl'
  ]
};

for (const [name, keys] of Object.entries(CALLERS)) {
  test(`${name}.mjml has no marker its callers cannot fill`, () => {
    const source = fs.readFileSync(path.join(TEMPLATES, `${name}.mjml`), 'utf-8');
    const values = Object.fromEntries([
      ['assetBaseUrl', 'https://assets.example.com'],
      ...keys.map((k) => [k, `value-of-${k}`])
    ]);
    const { output, unresolved } = fillTemplate(source, values);
    assert.deepEqual(unresolved, [], `unfilled in ${name}.mjml`);
    assert.equal(output.match(/\{\{/g), null, `a raw marker survived in ${name}.mjml`);
  });
}

test('the shipped otp template really does carry the code', () => {
  const source = fs.readFileSync(path.join(TEMPLATES, 'otp.mjml'), 'utf-8');
  const { output } = fillTemplate(source, {
    assetBaseUrl: 'https://assets.example.com',
    frontendUrl: 'https://orchard.my',
    otpCode: '424242',
    expiryMinutes: '10',
    recipientEmail: 'someone@example.com'
  });
  assert.ok(output.includes('424242'), 'the sign-in code is missing from the rendered email');
});
