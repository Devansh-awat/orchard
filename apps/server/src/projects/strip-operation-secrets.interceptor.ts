import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';

export function stripOperationSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOperationSecrets);
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key !== 'source' || !entry || typeof entry !== 'object') {
        return [key, stripOperationSecrets(entry)];
      }
      const { dbPassword: _dbPassword, ...source } = entry as Record<string, unknown>;
      return [key, stripOperationSecrets(source)];
    })
  );
}

@Injectable()
export class StripOperationSecretsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map(stripOperationSecrets));
  }
}
