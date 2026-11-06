import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { bodyTierFor, parseLargeBody } from './body-limits';

@Injectable()
export class LargeBodyInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest();
    if (req.body !== undefined || bodyTierFor(req.originalUrl ?? req.url) !== 'large') {
      return next.handle();
    }
    try {
      await parseLargeBody(req, http.getResponse());
    } catch (err: any) {
      if (err?.status === 413) throw new PayloadTooLargeException();
      throw new HttpException(err?.message ?? 'Invalid request body', err?.status ?? 400);
    }
    return next.handle();
  }
}
