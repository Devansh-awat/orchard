import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * AES-256-GCM at rest for IdP client secrets and signing certificates.
 *
 * The key derivation (SSO_ENCRYPTION_KEY + the 'sso-salt' literal) and the
 * iv:tag:ciphertext wire format are unchanged from the original SsoService, so
 * secrets written before the identity-provider rework still decrypt.
 */
@Injectable()
export class SsoCryptoService {
  private readonly key: Buffer | null;

  constructor() {
    const secret = process.env.SSO_ENCRYPTION_KEY;
    this.key = secret ? scryptSync(secret, 'sso-salt', 32) : null;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): string {
    if (!this.key) {
      throw new Error(
        "SSO_ENCRYPTION_KEY isn't configured; refusing to store SSO secrets in plaintext"
      );
    }
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(ciphertext: string): string {
    if (!this.key) {
      throw new Error("SSO_ENCRYPTION_KEY isn't configured; can't decrypt SSO secret");
    }
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid SSO ciphertext format');
    }
    const [ivHex, authTagHex, encryptedHex] = parts;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final()
    ]).toString('utf8');
  }

  decryptOrNull(ciphertext: string | null | undefined): string | undefined {
    if (!ciphertext) return undefined;
    try {
      return this.decrypt(ciphertext);
    } catch {
      return undefined;
    }
  }
}
