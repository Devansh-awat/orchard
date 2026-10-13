import type { AuthDoor, RequestAuthContext } from '@orchard/graft-sdk/server';

export type { RequestAuthContext };

type ContextDoor = Pick<AuthDoor, 'requestContext' | 'runWithContext'>;

let door: ContextDoor | null = null;

export function bindRequestContext(next: ContextDoor | null): void {
  door = next;
}

function bound(): ContextDoor {
  if (!door) throw new Error('the request context door is not bound');
  return door;
}

export const requestAuthStorage = {
  getStore(): RequestAuthContext | undefined {
    return bound().requestContext();
  },
  run<T>(ctx: RequestAuthContext, fn: () => T): T {
    return bound().runWithContext(ctx, fn);
  }
};
