import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// dotenv MUST run before telemetry so POSTHOG_API_KEY is available, and
// telemetry MUST run before Nest is imported so OTel instrumentation hooks
// are installed before any application code emits a log.
dotenv.config();
const envPath1 = resolve(process.cwd(), '..', '.env');
dotenv.config({ path: envPath1, override: false });
const envPath2 = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath2, override: false });

import { startTelemetry } from './analytics/telemetry';
startTelemetry();

import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { attachTerminalWebSocket } from './kubernetes/terminal.gateway';
import { OtelConsoleLogger } from './analytics/otel-logger';
import { AnalyticsService } from './analytics/analytics.service';
import { AnalyticsExceptionFilter } from './analytics/exception.filter';

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function() {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new OtelConsoleLogger() });

  app.setGlobalPrefix('apiv1');

  // Forward unhandled exceptions to PostHog Error Tracking. Registered after
  // app creation so HttpAdapterHost is resolvable for the BaseExceptionFilter.
  const { httpAdapter } = app.get(HttpAdapterHost);
  const analytics = app.get(AnalyticsService);
  app.useGlobalFilters(new AnalyticsExceptionFilter(analytics, httpAdapter));

  // Configure trust proxy so req.ip honors X-Forwarded-For ONLY when we are
  // behind a known proxy. The env var TRUST_PROXY accepts a hop count
  // ("1", "2"), "loopback"/"linklocal"/"uniquelocal", or a CIDR list.
  // Default: disabled (req.ip = socket peer), preventing XFF spoofing
  // when the app is reachable directly.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const n = Number(trustProxy);
    app.set('trust proxy', Number.isFinite(n) && n > 0 ? n : trustProxy);
  }

  app.use(cookieParser());

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  // Hosts that are part of the platform itself (login, status page, docs,
  // etc.) and may issue credentialed requests to the API. Comma-separated
  // origins, e.g. `https://app.orchard.dev,https://docs.orchard.dev`.
  const platformOrigins = new Set<string>(
    [
      frontendUrl,
      ...(process.env.PLATFORM_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ],
  );

  app.enableCors({
    origin: (origin, callback) => {
      // No-origin requests (curl, server-to-server) cannot ride a session
      // cookie cross-origin, so accepting them is harmless.
      if (!origin) return callback(null, true);

      if (platformOrigins.has(origin)) return callback(null, true);

      // Deliberately no `*.BASE_DOMAIN` wildcard: tenant-hosted apps live
      // under the same apex as platform infra in some configurations, and
      // a credentialed CORS match would let a tenant's JS read API
      // responses on behalf of a logged-in user. If you need to allow
      // additional first-party origins, add them to PLATFORM_ORIGINS.
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);

  // Attach WebSocket terminal handler to the underlying HTTP server
  const httpServer = app.getHttpServer();
  attachTerminalWebSocket(httpServer, app);

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}

bootstrap();

