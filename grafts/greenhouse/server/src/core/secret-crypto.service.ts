import { Inject, Injectable } from '@nestjs/common';
import { Doors, type SecretsDoor } from '@orchardlabs/graft-sdk/server';

@Injectable()
export class SecretCryptoService {
  constructor(@Inject(Doors.secrets) private readonly secrets: SecretsDoor) {}

  get enabled(): boolean {
    return this.secrets.enabled;
  }

  encrypt(plaintext: string): string {
    return this.secrets.encrypt(plaintext);
  }

  decrypt(value: string): string {
    return this.secrets.decrypt(value);
  }

  isEncrypted(value: string | null | undefined): boolean {
    return this.secrets.isEncrypted(value);
  }

  open<T extends string | null | undefined>(value: T): T {
    return this.secrets.open(value);
  }

  seal<T extends string | null | undefined>(value: T): T {
    return this.secrets.seal(value);
  }

  maybeDecrypt<T extends { value: string }>(row: T): T {
    return this.secrets.maybeDecrypt(row);
  }

  encryptForUser(userId: string, plaintext: string): string {
    return this.secrets.encryptForUser(userId, plaintext);
  }

  decryptForUser(userId: string, value: string): string {
    return this.secrets.decryptForUser(userId, value);
  }
}
