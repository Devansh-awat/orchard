import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'crypto';

/**
 * At-rest encryption for secret environment-variable values (AES-256-GCM),
 * mirroring the SSO service's approach. Encrypted values carry the `enc:v1:`
 * prefix so ciphertext is distinguishable from legacy plaintext, and decrypt is
 * idempotent: a value without the prefix is returned unchanged. That lets the
 * same reader handle both encrypted and not-yet-migrated rows.
 *
 * Key comes from SECRETS_ENCRYPTION_KEY (falls back to SSO_ENCRYPTION_KEY so an
 * existing deployment already has one). If no key is configured, encrypt() fails
 * closed: we never silently store secrets in plaintext.
 */
const PREFIX = 'enc:v1:';
const USER_PREFIX = 'enc:u1:';

@Injectable()
export class SecretCryptoService {
  private readonly logger = new Logger(SecretCryptoService.name);
  private readonly key: Buffer | null;

  constructor() {
    const secret = process.env.SECRETS_ENCRYPTION_KEY || process.env.SSO_ENCRYPTION_KEY;
    this.key = secret ? scryptSync(secret, 'orchard-env-secret', 32) : null;
    if (!this.key) {
      this.logger.error(
        [
          '',
          '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
          "!! SECRETS_ENCRYPTION_KEY isn't set.",
          '!! Secret env vars, shared vars, job step secrets and database passwords',
          '!! are being stored in PLAINTEXT in Postgres.',
          '!! Set SECRETS_ENCRYPTION_KEY to a long random string and restart; the',
          '!! boot backfill then encrypts existing env vars and credentials.',
          '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
        ].join('\n')
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
        "SECRETS_ENCRYPTION_KEY isn't configured; refusing to store secret env values in plaintext"
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
      throw new Error("SECRETS_ENCRYPTION_KEY isn't configured; can't decrypt secret env value");
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
   * failing: setting the key later + the boot backfill encrypts existing rows.
   */
  encryptIfSecret(value: string, secret: boolean | undefined | null): string {
    if (!secret || !this.key) return value;
    return this.encrypt(value);
  }

  encryptForUser(userId: string, plaintext: string): string {
    const key = this.userKey(userId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(userId, 'utf8'));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${USER_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  decryptForUser(userId: string, value: string): string {
    if (!value.startsWith(USER_PREFIX)) throw new Error('not a user-scoped ciphertext');
    const [ivB64, tagB64, ctB64] = value.slice(USER_PREFIX.length).split(':');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.userKey(userId),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  private userKey(userId: string): Buffer {
    if (!this.key) {
      throw new Error("SECRETS_ENCRYPTION_KEY isn't configured; refusing to store user context");
    }
    return Buffer.from(
      hkdfSync('sha256', this.key, Buffer.from(userId, 'utf8'), 'orchard-user-context', 32)
    );
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
