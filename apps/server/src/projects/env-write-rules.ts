import { BadRequestException } from '@nestjs/common';

/**
 * What a full-replace write to a deployment's environment actually stores.
 *
 * A secret value is write-only: it goes into the deployment's Kubernetes Secret
 * and no read ever hands it back, so a client that wants to change one variable
 * has no way to echo the others. The keep rules are what make a read-modify-
 * write round trip safe without that:
 *
 *   - `value === null` (or absent) keeps what is stored for an existing key
 *   - `value === ''` keeps it when the row is secret both before and after,
 *     which is the blank box the editor shows for a value it was never sent
 *   - un-marking a secret without supplying a value is refused, because the
 *     alternative is republishing in the clear the plaintext it was hiding
 *
 * A key that is new to the deployment has nothing to keep, so a null or blank
 * value stores an empty string, the same as it always did.
 */
export interface StoredEnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface EnvVarWrite {
  key: string;
  value?: string | null;
  secret?: boolean;
}

export function applyEnvKeepRules(
  input: EnvVarWrite[],
  before: Map<string, StoredEnvVar>,
): StoredEnvVar[] {
  return input
    .filter((entry) => entry && typeof entry.key === 'string')
    .map((entry) => {
      const key = entry.key.trim();
      const existing = before.get(key);
      const secret = Boolean(entry.secret);
      const blankKeepsSecret = entry.value === '' && existing?.secret && secret;
      const keeps = entry.value === undefined || entry.value === null || blankKeepsSecret;

      if (keeps && existing?.secret && !secret) {
        throw new BadRequestException(
          `Cannot un-mark ${key} as secret without providing a value`,
        );
      }

      return {
        key,
        value: keeps ? (existing?.value ?? '') : String(entry.value),
        secret,
      };
    })
    .filter((entry) => entry.key.length > 0);
}
