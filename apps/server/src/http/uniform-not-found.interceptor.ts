import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';

export const UNIFORM_NOT_FOUND_MESSAGE = 'Not found';

export function hasResourceParams(params: unknown): boolean {
  return !!params && typeof params === 'object' && Object.keys(params as object).length > 0;
}

@Injectable()
export class UniformNotFoundInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const params = context.switchToHttp().getRequest()?.params;
    if (!hasResourceParams(params)) return next.handle();
    return next
      .handle()
      .pipe(
        catchError((error) =>
          throwError(() =>
            error instanceof NotFoundException && error.constructor === NotFoundException
              ? new NotFoundException(UNIFORM_NOT_FOUND_MESSAGE)
              : error
          )
        )
      );
  }
}
