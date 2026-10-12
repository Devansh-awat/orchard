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

  encryptForUser(userId: string, plaintext: string) {
    return this.crypto.encryptForUser(userId, plaintext);
  }

  decryptForUser(userId: string, value: string) {
    return this.crypto.decryptForUser(userId, value);
  }
}
