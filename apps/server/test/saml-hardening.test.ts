import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { UnauthorizedException } from '@nestjs/common';
import { SsoLoginService } from '../src/sso/sso-login.service';
import { SsoService } from '../src/sso/sso.service';
import { SamlRequestStore } from '../src/sso/saml-request.store';
import { cleanEmail, extractIdentity } from '../src/sso/saml-response';
import { SAML_TEST_KEYS as KEYS } from './saml-test-keys';

const samlRequire = createRequire(require.resolve('@node-saml/node-saml'));
const { SignedXml } = samlRequire('xml-crypto');

const ACS_A = 'https://api.example/apiv1/sso/callback/provA';
const ACS_B = 'https://api.example/apiv1/sso/callback/provB';
const IDP = 'https://idp.example/metadata';
const SP_A = 'orchard-sso-org1-provA';
const SP_B = 'orchard-sso-org2-provB';

const pem = (cert: string) => cert.replace(/-----[A-Z ]+-----|\s+/g, '');

function provider(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: id === 'provA' ? 'org1' : 'org2',
    protocol: 'saml',
    samlEntryPoint: 'https://idp.example/sso',
    samlIdpEntityId: IDP,
    samlIssuer: null,
    samlCertificate: pem(KEYS.idp.cert),
    callbackPath: null,
    ...over
  };
}

function harness(over: Record<string, Record<string, unknown>> = {}) {
  const providers: Record<string, any> = {
    provA: provider('provA', over.provA),
    provB: provider('provB', over.provB)
  };
  const login = Object.create(SsoLoginService.prototype) as any;
  const secret = new TextEncoder().encode('test-secret-for-sso-start-cookie-0123456789');
  login.logger = { warn: (m: string) => process.env.DEBUG_SAML && console.log(m) };
  login.oauthService = { getJwtSecret: () => secret };
  login.sessionsService = { validateSession: async () => true };
  login.crypto = { decryptOrNull: (v: string | null) => v };
  login.samlRequests = new SamlRequestStore();
  login.sso = {
    callbackUrl: (p: any) => (p.id === 'provA' ? ACS_A : ACS_B),
    entityId: (p: any) => (p.id === 'provA' ? SP_A : SP_B),
    ensureIdpEntityId: async (p: any) => p
  };
  login.loadLoginProvider = async (id: string) => providers[id];
  login.completeLogin = async (_p: any, profile: any, returnTo: any, linked: any) => ({
    profile,
    returnTo,
    linked
  });
  return login;
}

async function begin(login: any, id: string, returnTo?: string) {
  const { url, startToken } = await login.startLogin(id, returnTo);
  const q = new URL(url).searchParams;
  const request = inflateRawSync(Buffer.from(q.get('SAMLRequest')!, 'base64')).toString();
  return {
    startToken,
    relay: q.get('RelayState')!,
    requestId: /ID="([^"]+)"/.exec(request)![1],
    request
  };
}

interface Opts {
  requestId: string | null;
  destination?: string;
  recipient?: string;
  issuer?: string;
  assertionIssuer?: string;
  audience?: string;
  nameId?: string;
  nameIdFormat?: string;
  notOnOrAfter?: Date;
  assertionId?: string;
  key?: { key: string; cert: string };
  signResponse?: boolean;
  signAssertion?: boolean;
  keyInfoCert?: boolean;
  sha1?: boolean;
  email?: string | string[];
  groups?: string[];
  extraAssertion?: boolean;
  wrap?: (xml: string) => string;
}

function sign(xml: string, ref: string, loc: string, opts: Opts) {
  const key = opts.key ?? KEYS.idp;
  const sig = new SignedXml({
    privateKey: key.key,
    publicCert: opts.keyInfoCert === false ? undefined : key.cert,
    signatureAlgorithm: opts.sha1
      ? 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
      : 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
  });
  sig.addReference({
    xpath: ref,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#'
    ],
    digestAlgorithm: opts.sha1
      ? 'http://www.w3.org/2000/09/xmldsig#sha1'
      : 'http://www.w3.org/2001/04/xmlenc#sha256'
  });
  sig.computeSignature(xml, { location: { reference: loc, action: 'after' } });
  return sig.getSignedXml() as string;
}

function response(o: Opts): string {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const end = iso((o.notOnOrAfter ?? new Date(now + 5 * 60_000)).getTime());
  const irt = o.requestId ? ` InResponseTo="${o.requestId}"` : '';
  const emails = Array.isArray(o.email) ? o.email : [o.email ?? 'ana@acme.test'];
  const values = emails.map((e) => `<saml:AttributeValue>${e}</saml:AttributeValue>`).join('');
  const groupAttr = o.groups
    ? `<saml:Attribute Name="groups">${o.groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute>`
    : '';
  const assertion = (id: string) =>
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${o.assertionIssuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID${o.nameIdFormat === undefined ? ' Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"' : o.nameIdFormat ? ` Format="${o.nameIdFormat}"` : ''}>${o.nameId ?? 'ana@acme.test'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} Recipient="${o.recipient ?? ACS_A}" NotOnOrAfter="${end}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 1000)}" NotOnOrAfter="${end}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP_A}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="email">${values}</saml:Attribute>${groupAttr}</saml:AttributeStatement>` +
    `</saml:Assertion>`;
  let a = assertion(o.assertionId ?? `_a${randomBytes(12).toString('hex')}`);
  if (o.signAssertion !== false) {
    a = sign(
      a,
      "/*[local-name(.)='Assertion']",
      "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      o
    );
  }
  const extra = o.extraAssertion ? assertion('_evil00000000') : '';
  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(12).toString('hex')}" Version="2.0" IssueInstant="${iso(now)}" Destination="${o.destination ?? ACS_A}"${irt}>` +
    `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${a}${extra}</samlp:Response>`;
  if (o.signResponse !== false) {
    xml = sign(
      xml,
      "/*[local-name(.)='Response']",
      "/*[local-name(.)='Response']/*[local-name(.)='Issuer']",
      o
    );
  }
  if (o.wrap) xml = o.wrap(xml);
  return Buffer.from(xml).toString('base64');
}

async function rejected(promise: Promise<unknown>) {
  await assert.rejects(promise, UnauthorizedException);
}

test('a valid SP-initiated response logs the user in', async () => {
  const login = harness();
  const s = await begin(login, 'provA', '/projects');
  const out = await login.handleSamlCallback(
    'provA',
    response({ requestId: s.requestId }),
    s.relay,
    s.startToken
  );
  assert.equal(out.profile.email, 'ana@acme.test');
  assert.equal(out.profile.emailVerified, true);
  assert.equal(out.returnTo, '/projects');
  assert.match(
    s.request,
    /AssertionConsumerServiceURL="https:\/\/api\.example\/apiv1\/sso\/callback\/provA"/
  );
});

test('an instance SAML provider only vouches for email when the operator trusts it', async () => {
  for (const [trustEmail, expected] of [
    [false, undefined],
    [true, true]
  ] as const) {
    const login = harness({ provA: { organizationId: null, trustEmail } });
    const s = await begin(login, 'provA');
    const out = await login.handleSamlCallback(
      'provA',
      response({ requestId: s.requestId }),
      s.relay,
      s.startToken
    );
    assert.equal(out.profile.emailVerified, expected);
  }
});

test('groups reach the mapper only from the signed assertion', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  const out = await login.handleSamlCallback(
    'provA',
    response({ requestId: s.requestId, groups: ['eng', 'leads'] }),
    s.relay,
    s.startToken
  );
  assert.deepEqual(out.profile.claims.groups, ['eng', 'leads']);

  const s2 = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: s2.requestId, groups: ['admins'], signAssertion: false }),
      s2.relay,
      s2.startToken
    )
  );
});

test('an unsolicited response carrying admin groups is still refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback('provA', response({ groups: ['admins'] }), s.relay, s.startToken)
  );
});

test('the AuthnRequest id is server generated and the relay state is a random nonce', async () => {
  const login = harness();
  const a = await begin(login, 'provA', 'https://evil.example');
  const b = await begin(login, 'provA');
  assert.match(a.requestId, /^_[0-9a-f]{40}$/);
  assert.notEqual(a.requestId, b.requestId);
  assert.match(a.relay, /^[0-9a-f]{48}$/);
  const ok = await login.handleSamlCallback(
    'provA',
    response({ requestId: a.requestId }),
    a.relay,
    a.startToken
  );
  assert.equal(ok.returnTo, undefined);
});

test('an unsolicited (IdP-initiated) response is refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback('provA', response({ requestId: null }), s.relay, s.startToken)
  );
});

test('a valid response for someone elses request does not log in this browser', async () => {
  const login = harness();
  const victim = await begin(login, 'provA');
  const attacker = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: victim.requestId }),
      attacker.relay,
      attacker.startToken
    )
  );
});

test('login CSRF: a response without the browser cookie or with a foreign relay state is refused', async () => {
  const prev = process.env.SESSION_COOKIE_SECURE;
  process.env.SESSION_COOKIE_SECURE = 'true';
  try {
    const login = harness();
    const victim = await begin(login, 'provA');
    const attacker = await begin(login, 'provA');
    const body = response({ requestId: attacker.requestId });
    await rejected(login.handleSamlCallback('provA', body, attacker.relay, undefined));
    await rejected(login.handleSamlCallback('provA', body, attacker.relay, victim.startToken));
    await rejected(login.handleSamlCallback('provA', body, 'f'.repeat(48), attacker.startToken));
    await rejected(login.handleSamlCallback('provA', body, undefined, attacker.startToken));
    const ok = await login.handleSamlCallback('provA', body, attacker.relay, attacker.startToken);
    assert.equal(ok.profile.email, 'ana@acme.test');
  } finally {
    if (prev === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = prev;
  }
});

test('a start token cannot be used for another provider or twice', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback('provB', response({ requestId: s.requestId }), s.relay, s.startToken)
  );
  const t = await begin(login, 'provA');
  const body = response({ requestId: t.requestId });
  await login.handleSamlCallback('provA', body, t.relay, t.startToken);
  await rejected(login.handleSamlCallback('provA', body, t.relay, t.startToken));
});

test('a captured response cannot be replayed on a fresh login', async () => {
  const login = harness();
  const first = await begin(login, 'provA');
  const body = response({ requestId: first.requestId });
  await login.handleSamlCallback('provA', body, first.relay, first.startToken);
  const second = await begin(login, 'provA');
  await rejected(login.handleSamlCallback('provA', body, second.relay, second.startToken));
});

test('the assertion id replay cache rejects a reused assertion id', async () => {
  const login = harness();
  const one = await begin(login, 'provA');
  await login.handleSamlCallback(
    'provA',
    response({ requestId: one.requestId, assertionId: '_sameassertion1' }),
    one.relay,
    one.startToken
  );
  const two = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: two.requestId, assertionId: '_sameassertion1' }),
      two.relay,
      two.startToken
    )
  );
});

test('a response minted for another provider or ACS is refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: s.requestId, destination: ACS_B }),
      s.relay,
      s.startToken
    )
  );
  const r = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: r.requestId, recipient: ACS_B }),
      r.relay,
      r.startToken
    )
  );
  const t = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: t.requestId, audience: SP_B }),
      t.relay,
      t.startToken
    )
  );
});

test("a request id from one provider is not accepted by another provider's callback", async () => {
  const login = harness();
  const a = await begin(login, 'provA');
  const b = await begin(login, 'provB');
  await rejected(
    login.handleSamlCallback(
      'provB',
      response({ requestId: a.requestId, destination: ACS_B, recipient: ACS_B, audience: SP_B }),
      b.relay,
      b.startToken
    )
  );
});

test('issuer must be the configured IdP entity id, and one must be configured', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: s.requestId, assertionIssuer: 'https://evil.example' }),
      s.relay,
      s.startToken
    )
  );
  const noIdp = harness({ provA: { samlIdpEntityId: null } });
  const t = await begin(noIdp, 'provA');
  await rejected(
    noIdp.handleSamlCallback('provA', response({ requestId: t.requestId }), t.relay, t.startToken)
  );
});

test('only the pinned certificate verifies, even if the response carries its own', async () => {
  const login = harness();
  for (const keyInfoCert of [true, false]) {
    const s = await begin(login, 'provA');
    await rejected(
      login.handleSamlCallback(
        'provA',
        response({ requestId: s.requestId, key: KEYS.other, keyInfoCert }),
        s.relay,
        s.startToken
      )
    );
  }
});

test('both the response and the assertion must be signed', async () => {
  const login = harness();
  for (const o of [{ signResponse: false }, { signAssertion: false }]) {
    const s = await begin(login, 'provA');
    await rejected(
      login.handleSamlCallback(
        'provA',
        response({ requestId: s.requestId, ...o }),
        s.relay,
        s.startToken
      )
    );
  }
});

test('signature wrapping: a second unsigned assertion is refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: s.requestId, extraAssertion: true, signResponse: false }),
      s.relay,
      s.startToken
    )
  );
  const t = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: t.requestId, extraAssertion: true }),
      t.relay,
      t.startToken
    )
  );
});

test('sha1 signatures are refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: s.requestId, sha1: true }),
      s.relay,
      s.startToken
    )
  );
});

test('expired assertions are refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      response({ requestId: s.requestId, notOnOrAfter: new Date(Date.now() - 5 * 60_000) }),
      s.relay,
      s.startToken
    )
  );
});

test('comments, DTDs, CDATA and entities are refused before parsing', async () => {
  const login = harness();
  const cases: Array<(x: string) => string> = [
    (x) => x.replace('ana@acme.test', 'ana@acme.test<!---->.evil.example'),
    (x) => `<!DOCTYPE r [<!ENTITY e "x">]>${x}`,
    (x) => x.replace('<samlp:Status>', '<![CDATA[x]]><samlp:Status>'),
    (x) => x.replace('<samlp:Status>', '<?pi x?><samlp:Status>'),
    (x) => x.replace('ana@acme.test', '&e;')
  ];
  for (const wrap of cases) {
    const s = await begin(login, 'provA');
    await rejected(
      login.handleSamlCallback(
        'provA',
        response({ requestId: s.requestId, signResponse: false, signAssertion: false, wrap }),
        s.relay,
        s.startToken
      )
    );
  }
});

test('oversized and absurdly nested responses are refused', async () => {
  const login = harness();
  const s = await begin(login, 'provA');
  await rejected(
    login.handleSamlCallback(
      'provA',
      Buffer.alloc(600_000, 'a').toString('base64'),
      s.relay,
      s.startToken
    )
  );
  const t = await begin(login, 'provA');
  const deep = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" Destination="${ACS_A}" Version="2.0">${'<a>'.repeat(100)}${'</a>'.repeat(100)}</samlp:Response>`;
  await rejected(
    login.handleSamlCallback('provA', Buffer.from(deep).toString('base64'), t.relay, t.startToken)
  );
});

test('identity extraction ignores ambiguous attributes and never reads roles', () => {
  const verified = {
    assertionId: 'x',
    expiresAt: 0,
    nameId: 'opaque-id',
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
  };
  assert.equal(extractIdentity(verified, { email: ['a@b.test', 'c@d.test'] }), null);
  assert.equal(extractIdentity(verified, { email: { _: 'a@b.test' } }), null);
  assert.equal(extractIdentity(verified, { email: 'a@b.test', role: 'owner' })!.email, 'a@b.test');
  assert.equal(
    extractIdentity({ ...verified, nameId: 'x@y.test', nameIdFormat: null }, {})!.email,
    'x@y.test'
  );
  assert.equal(cleanEmail('a b@c.test'), null);
  assert.equal(cleanEmail('a@b@c.test'), null);
  assert.equal(cleanEmail('<a>@c.test'), null);
});

test('IdP metadata only yields signing certificates', () => {
  const svc = Object.create(SsoService.prototype) as any;
  const xml = `<EntityDescriptor entityID="https://idp.example/m"><IDPSSODescriptor>
    <KeyDescriptor use="encryption"><KeyInfo><X509Data><X509Certificate>ENCCERT</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <KeyDescriptor use="signing"><KeyInfo><X509Data><X509Certificate>SIGNCERT</X509Certificate></X509Data></KeyInfo></KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/>
    </IDPSSODescriptor></EntityDescriptor>`;
  assert.equal(svc.parseIdpMetadata(xml).certificate, 'SIGNCERT');
  const onlyEnc = xml.replace('use="signing"', 'use="encryption"');
  assert.equal(svc.parseIdpMetadata(onlyEnc).certificate, null);
});

test('node-saml alone accepts a foreign Destination or Recipient, so our own checks must stay', async () => {
  const login = harness();
  for (const o of [{ destination: ACS_B }, { recipient: ACS_B }]) {
    const s = await begin(login, 'provA');
    const saml = login.buildSamlClient(provider('provA'));
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: response({ requestId: s.requestId, ...o })
    });
    assert.equal(profile?.nameID, 'ana@acme.test');
  }
});

test('node-saml itself rejects a foreign issuer and a foreign audience', async () => {
  const login = harness();
  for (const o of [
    { assertionIssuer: 'https://evil.example' },
    { issuer: 'https://evil.example' },
    { audience: SP_B }
  ]) {
    const s = await begin(login, 'provA');
    const saml = login.buildSamlClient(provider('provA'));
    await assert.rejects(
      saml.validatePostResponseAsync({ SAMLResponse: response({ requestId: s.requestId, ...o }) })
    );
  }
});
