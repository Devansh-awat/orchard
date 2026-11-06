import { BadRequestException } from '@nestjs/common';

export const SAML_MAX_ENCODED_BYTES = 512 * 1024;
export const SAML_MAX_XML_BYTES = 384 * 1024;
export const SAML_MAX_DEPTH = 40;
export const SAML_MAX_ELEMENTS = 5000;

function reject(): never {
  throw new BadRequestException('Invalid SAML response');
}

export function assertSafeSamlResponse(samlResponse: unknown): string {
  if (typeof samlResponse !== 'string' || samlResponse.length === 0) reject();
  const encoded = samlResponse as string;
  if (encoded.length > SAML_MAX_ENCODED_BYTES) reject();
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(encoded)) reject();

  const xml = Buffer.from(encoded, 'base64');
  if (xml.length === 0 || xml.length > SAML_MAX_XML_BYTES) reject();

  const text = xml.toString('utf8');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    reject();
  }
  if (text.includes('\u0000')) reject();

  let depth = 0;
  let elements = 0;
  const tag = /<(\/?)([^\s>/!?][^\s>]*)[^>]*?(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(text)) !== null) {
    if (match[1]) {
      depth--;
      if (depth < 0) reject();
      continue;
    }
    elements++;
    if (elements > SAML_MAX_ELEMENTS) reject();
    if (!match[3]) {
      depth++;
      if (depth > SAML_MAX_DEPTH) reject();
    }
  }
  return encoded;
}
