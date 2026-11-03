import { HttpException, HttpStatus } from '@nestjs/common';

// @kubernetes/client-node throws an `HttpError` whose `message` is the constant
// string 'HTTP request failed': the useful part (the API server's Status) is
// hidden on `body`. Nest's BaseExceptionFilter duck-types any error carrying
// `statusCode` + `message` and serialises it verbatim, so an unhandled k8s
// error reaches the caller as `{"statusCode":422,"message":"HTTP request
// failed"}`. Unwrap it before it gets there.

export function isK8sHttpError(e: unknown): boolean {
  const err = e as { name?: string; statusCode?: unknown; response?: { statusCode?: unknown } };
  if (!err || err.name !== 'HttpError') return false;
  const status = err.statusCode ?? err.response?.statusCode;
  return typeof status === 'number';
}

export function k8sErrorMessage(e: unknown): string {
  const err = e as { body?: unknown; message?: string };
  const body = err?.body;
  const message = typeof body === 'string' ? body : (body as { message?: unknown })?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return String(err?.message ?? e);
}

// k8s auth failures are about *our* service account, never the caller's
// credentials, so passing 401/403 straight through would tell a user they lack
// permission when the cluster connection is what's broken.
export function k8sHttpException(e: unknown): HttpException | null {
  if (!isK8sHttpError(e)) return null;
  const err = e as { statusCode?: number; response?: { statusCode?: number } };
  const status = err.statusCode ?? err.response?.statusCode ?? HttpStatus.BAD_GATEWAY;
  const mapped =
    status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN
      ? HttpStatus.BAD_GATEWAY
      : status;
  return new HttpException(k8sErrorMessage(e), mapped);
}
