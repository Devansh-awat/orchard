import assert from 'node:assert/strict';
import test from 'node:test';
import { smtpFailureMessage } from '../src/email/email.service';

test('a failed SMTP test says what went wrong in plain words', () => {
  const say = (error: any) => smtpFailureMessage(error, 'mail.test', 587);
  assert.equal(
    say({ code: 'EDNS', message: 'getaddrinfo ENOTFOUND mail.test' }),
    'Could not find mail.test.'
  );
  assert.equal(
    say({ code: 'ESOCKET', message: 'connect ECONNREFUSED 10.0.0.1:587' }),
    'mail.test refused the connection on port 587.'
  );
  assert.match(
    say({ code: 'ETIMEDOUT', message: 'Connection timeout' }),
    /No answer from mail\.test/
  );
  assert.equal(
    say({ code: 'EAUTH', message: 'Invalid login: 535' }),
    'The server refused the username or password.'
  );
  assert.equal(say({ message: 'something new' }), 'something new');
  assert.equal(say(null), "Couldn't send the test email.");
});
