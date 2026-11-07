import type { Prisma } from '@prisma/client';
import { lockHostnameClaims } from '../instance-network/reserved-hosts';

export interface HostClaim {
  tx: Prisma.TransactionClient;
  close(commit: boolean): Promise<void>;
}

interface Transactional {
  $transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<T>;
}

const ROLLBACK = Symbol('host-claim-rollback');
const HOLD_LIMIT_MS = 120_000;

export function beginHostClaim(
  prisma: Transactional,
  check: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<HostClaim> {
  return new Promise<HostClaim>((resolve, reject) => {
    let finish!: (commit: boolean) => void;
    const hold = new Promise<boolean>((r) => {
      finish = r;
    });
    const done = prisma
      .$transaction(
        async (tx) => {
          await lockHostnameClaims(tx);
          await check(tx);
          resolve({
            tx,
            close: async (commit) => {
              finish(commit);
              await done.catch(() => undefined);
            }
          });
          if (!(await hold)) throw ROLLBACK;
        },
        { maxWait: 10_000, timeout: HOLD_LIMIT_MS }
      )
      .catch((error) => {
        if (error !== ROLLBACK) reject(error);
      });
  });
}
