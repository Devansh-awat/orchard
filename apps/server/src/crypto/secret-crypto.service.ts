import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * At-rest encryption for secret environment-variable values (AES-256-GCM),
 * mirroring the SSO service's approach. Encrypted values carry the `enc:v1:`
 * prefix so ciphertext is distinguishable from legacy plaintext, and decrypt is
 * idempotent — a value without the prefix is returned unchanged. That lets the
 * same reader handle both encrypted and not-yet-migrated rows.
 *
 * Key comes from SECRETS_ENCRYPTION_KEY (falls back to SSO_ENCRYPTION_KEY so an
 * existing deployment already has one). If no key is configured, encrypt() fails
 * closed — we never silently store secrets in plaintext.
 */
const PREFIX = 'enc:v1:';

@Injectable()
export class SecretCryptoService {
  private readonly logger = new Logger(SecretCryptoService.name);
  private readonly key: Buffer | null;

  constructor() {
    const secret = process.env.SECRETS_ENCRYPTION_KEY || process.env.SSO_ENCRYPTION_KEY;
    this.key = secret ? scryptSync(secret, 'orchard-env-secret', 32) : null;
    if (!this.key) {
      this.logger.warn(
        'SECRETS_ENCRYPTION_KEY not set — secret env values cannot be encrypted at rest.'
      );
    }
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  encrypt(plaintext: string): string {
    if (!this.key) {
      throw new Error(
        'SECRETS_ENCRYPTION_KEY is not configured; refusing to store secret env values in plaintext'
      );
    }
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    if (!this.key) {
      throw new Error('SECRETS_ENCRYPTION_KEY is not configured; cannot decrypt secret env value');
    }
    const [ivHex, tagHex, ctHex] = value.slice(PREFIX.length).split(':');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
      'utf8'
    );
  }

  /**
   * Encrypt only when the row is marked secret. Degrades gracefully: with no key
   * configured, the value is stored as-is (plaintext, as before) rather than
   * failing — setting the key later + the boot backfill encrypts existing rows.
   */
  encryptIfSecret(value: string, secret: boolean | undefined | null): string {
    if (!secret || !this.key) return value;
    return this.encrypt(value);
  }

  /** Decrypt any ciphertext (idempotent on plaintext). */
  maybeDecrypt<T extends { value: string }>(row: T): T {
    return this.isEncrypted(row.value) ? { ...row, value: this.decrypt(row.value) } : row;
  }

  seal<T extends string | null | undefined>(value: T): T {
    if (!this.key || typeof value !== 'string' || value === '' || this.isEncrypted(value)) {
      return value;
    }
    return this.encrypt(value) as T;
  }

  open<T extends string | null | undefined>(value: T): T {
    if (typeof value !== 'string') return value;
    return this.decrypt(value) as T;
  }
}
