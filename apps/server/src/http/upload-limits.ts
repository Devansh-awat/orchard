import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  Type
} from '@nestjs/common';
import { finalize, type Observable } from 'rxjs';

const MB = 1024 * 1024;

export const AVATAR_UPLOAD_BYTES = 5 * MB;
export const APP_ICON_UPLOAD_BYTES = 2 * MB;
export const PROJECT_ICON_UPLOAD_BYTES = 2 * MB;
export const PROJECT_BACKGROUND_UPLOAD_BYTES = 8 * MB;
export const BUILD_CONTEXT_UPLOAD_BYTES = 100 * MB;

export function uploadLimits(fileSize: number) {
  return {
    limits: {
      fileSize,
      files: 1,
      fields: 4,
      parts: 6,
      fieldSize: 16 * 1024,
      fieldNameSize: 100,
      headerPairs: 50
    }
  };
}

function callerKey(req: any): string {
  return String(req?.user?.sub ?? req?.ip ?? 'anonymous');
}

export function uploadSlots(maxTotal: number, maxPerCaller: number): Type<NestInterceptor> {
  let inFlight = 0;
  const perCaller = new Map<string, number>();

  @Injectable()
  class UploadSlotInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      if (context.getType() !== 'http') return next.handle();
      const key = callerKey(context.switchToHttp().getRequest());
      const mine = perCaller.get(key) ?? 0;
      if (inFlight >= maxTotal || mine >= maxPerCaller) {
        throw new HttpException('Too many uploads in progress. Try again shortly.', 429);
      }
      inFlight += 1;
      perCaller.set(key, mine + 1);
      let released = false;
      return next.handle().pipe(
        finalize(() => {
          if (released) return;
          released = true;
          inFlight -= 1;
          const left = (perCaller.get(key) ?? 1) - 1;
          if (left <= 0) perCaller.delete(key);
          else perCaller.set(key, left);
        })
      );
    }
  }

  return UploadSlotInterceptor;
}

export const ImageUploadSlots = uploadSlots(32, 4);

export const BuildContextUploadSlots = uploadSlots(4, 2);
