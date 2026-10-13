import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindRequestContext, type RequestAuthContext } from '../../server/src/core/request-context';

const storage = new AsyncLocalStorage<RequestAuthContext>();

export function bindTestRequestContext(): void {
  bindRequestContext({
    requestContext: () => storage.getStore(),
    runWithContext: (ctx, fn) => storage.run(ctx, fn)
  });
}

bindTestRequestContext();
