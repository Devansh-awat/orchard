import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
  applyDecorators
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { UNIFORM_NOT_FOUND_MESSAGE } from '../http/uniform-not-found.interceptor';

const SSE_PREFLIGHT_KEY = 'orchard:sse-preflight';

@Injectable()
export class SsePreflightGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const method = this.reflector.get<string | undefined>(SSE_PREFLIGHT_KEY, context.getHandler());
    if (!method) return true;
    const controller = this.moduleRef.get(context.getClass(), { strict: false }) as Record<
      string,
      unknown
    >;
    const check = controller[method];
    if (typeof check !== 'function') {
      throw new Error(`SsePreflight: ${context.getClass().name}.${method} is not a method`);
    }
    try {
      await check.call(controller, context.switchToHttp().getRequest());
    } catch (error) {
      // The uniform-not-found interceptor never sees a guard's exception.
      if (error instanceof NotFoundException && error.constructor === NotFoundException) {
        throw new NotFoundException(UNIFORM_NOT_FOUND_MESSAGE);
      }
      throw error;
    }
    return true;
  }
}

/**
 * Nest commits an SSE response (200, text/event-stream) on the next macrotask
 * once the route is wrapped in interceptors, and the global interceptors always
 * wrap it. An authorization check that awaits anything inside an `@Sse` handler
 * therefore loses the race: a denied caller gets a 200 and an in-band
 * `event: error`, or a 404, depending on whether the lookup was cached.
 *
 * Running the check as a guard happens before any of that, so a denied caller
 * always gets the same plain 404/403 as on every other route. `method` names a
 * method on the controller that receives the raw request and throws to deny.
 */
export function SsePreflight(method: string) {
  return applyDecorators(SetMetadata(SSE_PREFLIGHT_KEY, method), UseGuards(SsePreflightGuard));
}
