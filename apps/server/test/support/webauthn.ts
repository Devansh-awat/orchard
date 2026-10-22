import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

export const passkeyUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'passkey@example.test'
};

export type Algorithm = 'ES256' | 'RS256' | 'Ed25519';
export type CeremonyOptions = {
  counter?: number;
  userVerified?: boolean;
  backupEligible?: boolean;
  backedUp?: boolean;
  userHandle?: string;
};

export function authenticator(algorithm: Algorithm = 'ES256') {
  const keys =
    algorithm === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : algorithm === 'RS256'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ed25519');
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
  const alg = algorithm === 'ES256' ? -7 : algorithm === 'RS256' ? -257 : -8;
  const cose = new Map<number, number | Uint8Array>(
    algorithm === 'ES256'
      ? [
          [1, 2],
          [3, alg],
          [-1, 1],
          [-2, bytes(jwk.x!)],
          [-3, bytes(jwk.y!)]
        ]
      : algorithm === 'RS256'
        ? [
            [1, 3],
            [3, alg],
            [-1, bytes(jwk.n!)],
            [-2, bytes(jwk.e!)]
          ]
        : [
            [1, 1],
            [3, alg],
            [-1, 6],
            [-2, bytes(jwk.x!)]
          ]
  );
  const publicKey = isoCBOR.encode(cose);
  const credentialId = randomBytes(32);
  const id = credentialId.toString('base64url');
  const hash = (data: string | Buffer) => createHash('sha256').update(data).digest();
  const signature = (data: Buffer) =>
    sign(algorithm === 'Ed25519' ? null : 'sha256', data, keys.privateKey);

  function clientData(challenge: string, type: string) {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: 'http://localhost:4000',
        crossOrigin: false
      })
    );
  }

  function authData(options: CeremonyOptions, registration: boolean) {
    const flags =
      1 |
      (options.userVerified === false ? 0 : 4) |
      (options.backupEligible ? 8 : 0) |
      (options.backedUp ? 16 : 0) |
      (registration ? 64 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(options.counter ?? 0);
    const parts = [hash('localhost'), Buffer.from([flags]), counter];
    if (registration) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      parts.push(Buffer.alloc(16), length, credentialId, Buffer.from(publicKey));
    }
    return Buffer.concat(parts);
  }

  return {
    id,
    publicKey,
    registration(
      challenge: string,
      options: CeremonyOptions & { attestation?: 'none' | 'packed' } = {}
    ): RegistrationResponseJSON {
      const client = clientData(challenge, 'webauthn.create');
      const data = authData(options, true);
      const fmt = options.attestation ?? 'none';
      const attStmt =
        fmt === 'packed'
          ? new Map<string, number | Uint8Array>([
              ['alg', alg],
              ['sig', new Uint8Array(signature(Buffer.concat([data, hash(client)])))]
            ])
          : new Map();
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, number | Uint8Array>>([
          ['fmt', fmt],
          ['authData', new Uint8Array(data)],
          ['attStmt', attStmt]
        ])
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal', 'hybrid']
        }
      };
    },
    authentication(challenge: string, options: CeremonyOptions = {}): AuthenticationResponseJSON {
      const client = clientData(challenge, 'webauthn.get');
      const data = authData(options, false);
      return {
        id,
        rawId: id,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          authenticatorData: data.toString('base64url'),
          signature: signature(Buffer.concat([data, hash(client)])).toString('base64url'),
          userHandle: options.userHandle ?? Buffer.from(passkeyUser.id).toString('base64url')
        }
      };
    }
  };
}
