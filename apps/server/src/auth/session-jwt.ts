import type { JWTPayload } from 'jose';

export class NotBrowserSessionError extends Error {
  constructor(reason: string) {
    super(`not a browser session token: ${reason}`);
    this.name = 'NotBrowserSessionError';
  }
}

export function assertBrowserSession(payload: JWTPayload): string {
  if (payload.type !== undefined) {
    throw new NotBrowserSessionError(`type=${String(payload.type)}`);
  }
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new NotBrowserSessionError('missing sessionId');
  }
  return sessionId;
}
