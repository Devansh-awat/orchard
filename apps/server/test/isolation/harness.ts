import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { resolveTestDatabase } from '../support/test-database';

export const JWT_SECRET = 'isolation-harness-jwt-secret-isolation-harness-jwt-secret';
export const MCP_SERVICE_TOKEN = 'isolation-harness-mcp-service-token';

export interface Harness {
  app: NestExpressApplication;
  baseUrl: string;
  prisma: PrismaClient;
  secret: Uint8Array;
  close(): Promise<void>;
}

function deadKubeconfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'isolation-kube-'));
  const file = path.join(dir, 'config');
  writeFileSync(
    file,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: dead',
      '  cluster:',
      '    server: http://127.0.0.1:1',
      'contexts:',
      '- name: dead',
      '  context: {cluster: dead, user: dead}',
      'current-context: dead',
      'users:',
      '- name: dead',
      '  user: {}',
      ''
    ].join('\n')
  );
  return file;
}

export function configureEnvironment(): string {
  const db = resolveTestDatabase();
  if ('refused' in db) throw new Error(db.refused);
  process.env.DATABASE_URL = db.url;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.MCP_SERVICE_TOKEN = MCP_SERVICE_TOKEN;
  process.env.KUBECONFIG = deadKubeconfig();
  process.env.HOME = mkdtempSync(path.join(tmpdir(), 'isolation-home-'));
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.REDIS_URL;
  delete process.env.ORCHARD_CONTROL_NAMESPACE;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'test';
  process.env.DD_TRACE_ENABLED = 'false';
  process.env.OTEL_SDK_DISABLED = 'true';
  process.env.FRONTEND_URL = 'http://localhost:4000';
  return db.url;
}

export async function bootHarness(): Promise<Harness> {
  const databaseUrl = configureEnvironment();
  const { NestFactory } = await import('@nestjs/core');
  const { PrismaClient } = await import('@prisma/client');
  const { default: cookieParser } = await import('cookie-parser');
  const { AppModule } = await import('../../src/app.module');
  const { ApiThrottlerGuard } = await import('../../src/auth/api-throttler.guard');
  const { registerBodyParsers } = await import('../../src/http/body-limits');
  const { requestAuthStorage } = await import('../../src/auth/request-context');

  process.on('unhandledRejection', () => undefined);
  process.on('uncaughtException', () => undefined);

  ApiThrottlerGuard.prototype.canActivate = async () => true;

  // The cluster address is dead on purpose. Fail pod exec cleanly instead of opening a websocket.
  const k8sClient = await import('@kubernetes/client-node');
  k8sClient.Exec.prototype.exec = async () => {
    throw new Error('pod exec is unavailable in the isolation harness');
  };

  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
    return this.toString();
  };

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
    abortOnError: false,
    logger: false
  });
  const { HttpAdapterHost } = await import('@nestjs/core');
  const { RecordingExceptionFilter } = await import('./recording-filter');
  app.useGlobalFilters(new RecordingExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  app.disable('x-powered-by');
  registerBodyParsers((type, options) => app.useBodyParser(type, options));
  app.setGlobalPrefix('apiv1');
  app.use(cookieParser());
  app.use((_req: unknown, _res: unknown, next: () => void) => {
    requestAuthStorage.run({}, next);
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}/apiv1`,
    prisma,
    secret: new TextEncoder().encode(JWT_SECRET),
    async close() {
      await app.close().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    }
  };
}
