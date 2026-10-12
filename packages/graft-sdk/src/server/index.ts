import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

export * from './doors';

export type ApiTokenScope = 'read' | 'deploy' | 'exec';

export const Public = () => SetMetadata('isPublic', true);
export const Auth = () => SetMetadata('requiresAuth', true);
export const SuperAdmin = () => SetMetadata('requires_superadmin', true);
export const RequireScope = (scope: ApiTokenScope) => SetMetadata('required_scope', scope);

export const GraftUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<{ auth?: { userId?: string } }>();
    return request.auth?.userId;
  }
);

export type McpRegister = (
  server: {
    registerTool(
      name: string,
      config: Record<string, unknown>,
      handler: (...args: never[]) => unknown
    ): unknown;
  },
  client: {
    get<T = unknown>(path: string): Promise<T>;
    post<T = unknown>(path: string, body?: unknown): Promise<T>;
    put<T = unknown>(path: string, body?: unknown): Promise<T>;
    patch<T = unknown>(path: string, body?: unknown): Promise<T>;
    delete<T = unknown>(path: string, body?: unknown): Promise<T>;
  },
  context: { graftId: string; apiBase: string }
) => void;

export const defineMcp = (register: McpRegister): { register: McpRegister } => ({ register });
