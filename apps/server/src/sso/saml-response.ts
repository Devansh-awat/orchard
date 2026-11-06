import { createHash, timingSafeEqual } from 'crypto';

export class SamlRejected extends Error {}

const MAX_BASE64_CHARS = 700_000;
const MAX_XML_BYTES = 512 * 1024;
const MAX_DEPTH = 40;
const MAX_ELEMENTS = 4000;

const ALLOWED_ALGORITHMS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  'http://www.w3.org/2006/12/xml-c14n11',
  'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
]);

const ATTR = String.raw`\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*')`;
const ROOT_TAG = new RegExp(String.raw`^\s*<(?:[\w.-]+:)?Response((?:${ATTR})*)\s*>`);
const ANY_TAG = new RegExp(String.raw`<(/?)([\w.:-]+)(?:${ATTR})*\s*(/?)>`, 'g');
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (out.has(m[1])) throw new SamlRejected('duplicate attribute');
    out.set(m[1], decodeEntities(m[2] ?? m[3] ?? ''));
  }
  return out;
}

export function precheckSamlResponse(samlResponse: unknown, acsUrl: string): string {
  if (typeof samlResponse !== 'string' || !samlResponse || samlResponse.length > MAX_BASE64_CHARS) {
    throw new SamlRejected('bad SAMLResponse size');
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(samlResponse))
    throw new SamlRejected('bad SAMLResponse encoding');
  const buf = Buffer.from(samlResponse, 'base64');
  if (buf.length === 0 || buf.length > MAX_XML_BYTES)
    throw new SamlRejected('bad SAMLResponse size');
  if (buf.includes(0)) throw new SamlRejected('NUL byte in SAMLResponse');
  const xml = buf.toString('utf8');
  if (xml.includes('�')) throw new SamlRejected('SAMLResponse is not UTF-8');

  const body = xml.replace(/^﻿?\s*<\?xml\s[^?<>]*\?>/, '');
  if (/<[!?]/.test(body)) throw new SamlRejected('DTD, comment, CDATA or PI in SAMLResponse');
  if (/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body)) {
    throw new SamlRejected('custom entity in SAMLResponse');
  }

  const root = ROOT_TAG.exec(body);
  if (!root) throw new SamlRejected('root is not a Response');
  const rootAttrs = attributes(root[1]);
  if (rootAttrs.get('Destination') !== acsUrl) throw new SamlRejected('Destination mismatch');
  if (rootAttrs.get('Version') !== '2.0') throw new SamlRejected('bad Version');

  let depth = 0;
  let max = 0;
  let count = 0;
  let matched = 0;
  for (const m of body.matchAll(ANY_TAG)) {
    matched += 1;
    if (m[1]) depth -= 1;
    else {
      count += 1;
      if (!m[3]) depth += 1;
      max = Math.max(max, depth);
    }
    if (depth < 0 || max > MAX_DEPTH || count > MAX_ELEMENTS) {
      throw new SamlRejected('SAMLResponse too deep or too large');
    }
  }
  if (matched !== (body.match(/</g) ?? []).length || depth !== 0) {
    throw new SamlRejected('malformed SAMLResponse');
  }

  if (/Encrypted(?:Assertion|ID|Attribute)/.test(body)) {
    throw new SamlRejected('encrypted content is not supported');
  }
  if ((body.match(/<(?:[\w.-]+:)?Assertion[\s>/]/g) ?? []).length !== 1) {
    throw new SamlRejected('expected exactly one Assertion');
  }

  for (const m of body.matchAll(/\bAlgorithm\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (!ALLOWED_ALGORITHMS.has(m[1] ?? m[2])) throw new SamlRejected('algorithm not allowed');
  }
  return xml;
}

type Node = Record<string, any>;

const text = (list: unknown): string | null => {
  if (!Array.isArray(list) || list.length !== 1) return null;
  const v = list[0];
  if (typeof v === 'string') return v;
  return typeof v?._ === 'string' ? v._ : null;
};

const only = (node: Node | undefined, key: string): Node | null => {
  const list = node?.[key];
  return Array.isArray(list) && list.length === 1 && typeof list[0] === 'object' ? list[0] : null;
};

const time = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export interface VerifiedAssertion {
  assertionId: string;
  expiresAt: number;
  nameId: string;
  nameIdFormat: string | null;
}

export interface AssertionContext {
  acsUrl: string;
  idpEntityId: string;
  audience: string;
  requestId: string;
  now: number;
  skewMs: number;
  maxAgeMs: number;
}

export function verifyAssertion(parsed: Node, ctx: AssertionContext): VerifiedAssertion {
  const a = parsed?.Assertion as Node | undefined;
  if (!a) throw new SamlRejected('no assertion');
  if (a.$?.Version !== '2.0') throw new SamlRejected('bad assertion Version');
  const id = a.$?.ID;
  if (typeof id !== 'string' || !/^[A-Za-z_][\w.-]{7,199}$/.test(id)) {
    throw new SamlRejected('bad assertion ID');
  }
  const issued = time(a.$?.IssueInstant);
  if (issued === null || issued - ctx.skewMs > ctx.now) throw new SamlRejected('bad IssueInstant');
  if (ctx.now - ctx.skewMs >= issued + ctx.maxAgeMs) throw new SamlRejected('assertion too old');

  if (text(a.Issuer) !== ctx.idpEntityId) throw new SamlRejected('Issuer mismatch');

  const subject = only(a, 'Subject');
  if (!subject) throw new SamlRejected('no Subject');
  const nameIdNode = only(subject, 'NameID');
  const nameId = text(subject.NameID);
  if (!nameIdNode || !nameId || nameId !== nameId.trim()) throw new SamlRejected('bad NameID');
  if (nameId.length > 320) throw new SamlRejected('NameID too long');
  const nameIdFormat = typeof nameIdNode.$?.Format === 'string' ? nameIdNode.$.Format : null;
  if (nameIdFormat === 'urn:oasis:names:tc:SAML:2.0:nameid-format:encrypted') {
    throw new SamlRejected('encrypted NameID');
  }

  let expiresAt = 0;
  const confirmations: Node[] = subject.SubjectConfirmation ?? [];
  const ok = confirmations.some((c) => {
    if (c.$?.Method !== BEARER) return false;
    const data = only(c, 'SubjectConfirmationData');
    const d = data?.$;
    if (!d || d.Recipient !== ctx.acsUrl || d.InResponseTo !== ctx.requestId) return false;
    const notOnOrAfter = time(d.NotOnOrAfter);
    if (notOnOrAfter === null || ctx.now - ctx.skewMs >= notOnOrAfter) return false;
    if (d.NotBefore !== undefined) {
      const notBefore = time(d.NotBefore);
      if (notBefore === null || ctx.now + ctx.skewMs < notBefore) return false;
    }
    expiresAt = notOnOrAfter;
    return true;
  });
  if (!ok) throw new SamlRejected('no valid bearer SubjectConfirmation');

  const conditions = only(a, 'Conditions');
  const cond = conditions?.$;
  if (!conditions || !cond) throw new SamlRejected('no Conditions');
  const condEnd = time(cond.NotOnOrAfter);
  if (condEnd === null || ctx.now - ctx.skewMs >= condEnd)
    throw new SamlRejected('Conditions expired');
  if (cond.NotBefore !== undefined) {
    const condStart = time(cond.NotBefore);
    if (condStart === null || ctx.now + ctx.skewMs < condStart) {
      throw new SamlRejected('Conditions not yet valid');
    }
  }
  const restrictions: Node[] = conditions.AudienceRestriction ?? [];
  if (
    restrictions.length === 0 ||
    !restrictions.every((r) => (r.Audience ?? []).some((x: Node) => x?._ === ctx.audience))
  ) {
    throw new SamlRejected('audience mismatch');
  }

  return {
    assertionId: id,
    expiresAt: Math.min(expiresAt, condEnd, issued + ctx.maxAgeMs),
    nameId,
    nameIdFormat
  };
}

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3'
];

export function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (
    email.length > 254 ||
    !/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

function stringAttribute(attrs: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const v = attrs[name];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

const NAMEID_EMAIL_FORMATS = new Set([
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
]);

export function extractIdentity(
  verified: VerifiedAssertion,
  attrs: Record<string, unknown>
): { email: string; name: string } | null {
  const fromNameId =
    verified.nameIdFormat === null || NAMEID_EMAIL_FORMATS.has(verified.nameIdFormat)
      ? cleanEmail(verified.nameId)
      : null;
  const email = fromNameId ?? cleanEmail(stringAttribute(attrs, EMAIL_ATTRIBUTES));
  if (!email) return null;
  const first = stringAttribute(attrs, ['firstName', 'givenName', 'givenname']) ?? '';
  const last = stringAttribute(attrs, ['lastName', 'surname', 'sn']) ?? '';
  const display =
    `${first} ${last}`.trim() ||
    stringAttribute(attrs, ['displayName', 'name']) ||
    email.split('@')[0];
  return {
    email,
    name: display
      .replace(/[\u0000-\u001f\u007f<>]/g, '')
      .trim()
      .slice(0, 200)
  };
}

export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
