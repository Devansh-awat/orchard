import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
  UseInterceptors
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Observable, catchError, from, mergeMap, of, throwError } from 'rxjs';
import { IDEMPOTENCY_STORE, IdempotencyStore } from './idempotency.store';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_PENDING_TTL_MS = 10 * 60 * 1000;
export const IDEMPOTENCY_MAX_BODY_BYTES = 256 * 1024;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function idempotencyScope(req: Record<string, any>, key: string): string {
  const principal = req.user?.sub ?? req.user?.id ?? 'anonymous';
  const route = req.route?.path ?? req.path ?? req.url ?? '';
  return sha256(
    [principal, req.method, route, stableStringify(req.params ?? {}), key].join('\u0000')
  );
}

export function idempotencyFingerprint(req: Record<string, any>): string {
  return sha256(stableStringify({ query: req.query ?? {}, body: req.body ?? null }));
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const raw = req.headers?.['idempotency-key'];
    if (raw === undefined) return next.handle();
    if (typeof raw !== 'string' || !KEY_RE.test(raw)) {
      throw new BadRequestException('Idempotency-Key must be 1-255 visible ASCII characters');
    }
    if (!this.store.available) return next.handle();

    const key = idempotencyScope(req, raw);
    const fingerprint = idempotencyFingerprint(req);

    let claimed: boolean;
    try {
      claimed = await this.store.claim(key, fingerprint, IDEMPOTENCY_PENDING_TTL_MS);
    } catch {
      return next.handle();
    }

    if (!claimed) {
      const existing = await this.store.get(key).catch(() => null);
      if (!existing) return next.handle();
      if (existing.fingerprint !== fingerprint) {
        throw new UnprocessableEntityException(
          'Idempotency-Key was already used with a different request'
        );
      }
      if (existing.state === 'pending') {
        throw new ConflictException('A request with this Idempotency-Key is still in progress');
      }
      res.setHeader?.('Idempotent-Replayed', 'true');
      return of(existing.body);
    }

    return next.handle().pipe(
      mergeMap((body) =>
        from(this.remember(key, fingerprint, res?.statusCode ?? 200, body)).pipe(
          mergeMap(() => of(body))
        )
      ),
      catchError((err) =>
        from(this.store.release(key).catch(() => undefined)).pipe(
          mergeMap(() => throwError(() => err))
        )
      )
    );
  }

  private async remember(key: string, fingerprint: string, status: number, body: unknown) {
    try {
      const size = Buffer.byteLength(JSON.stringify(body ?? null) ?? 'null');
      if (size > IDEMPOTENCY_MAX_BODY_BYTES) {
        await this.store.release(key);
        return;
      }
      await this.store.complete(
        key,
        { state: 'done', fingerprint, status, body: body ?? null },
        IDEMPOTENCY_TTL_MS
      );
    } catch {
      await this.store.release(key).catch(() => undefined);
    }
  }
}

export const Idempotent = () => UseInterceptors(IdempotencyInterceptor);
