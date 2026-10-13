import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { SecretCryptoService } from '../../crypto/secret-crypto.service';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class SecretsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'secrets',
    version: 1,
    status: 'stable',
    capability: 'secrets'
  };

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(SecretCryptoService) private readonly crypto: SecretCryptoService
  ) {
    bindGraft(parent, SecretsDoorV1.meta);
  }

  encrypt(plaintext: string) {
    return this.crypto.encrypt(plaintext);
  }

  decrypt(value: string) {
    return this.crypto.decrypt(value);
  }

  isEncrypted(value: string | null | undefined) {
    return this.crypto.isEncrypted(value);
  }

  get enabled(): boolean {
    return this.crypto.enabled;
  }

  seal<T extends string | null | undefined>(value: T): T {
    return this.crypto.seal(value);
  }

  open<T extends string | null | undefined>(value: T): T {
    return this.crypto.open(value);
  }

  maybeDecrypt<T extends { value: string }>(row: T): T {
    return this.crypto.maybeDecrypt(row);
  }

  encryptForUser(userId: string, plaintext: string) {
    return this.crypto.encryptForUser(userId, plaintext);
  }

  decryptForUser(userId: string, value: string) {
    return this.crypto.decryptForUser(userId, value);
  }
}
