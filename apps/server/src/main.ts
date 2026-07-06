import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// dd-trace must init before Nest/express/prisma are required so its module
// patching can instrument them (APM traces + continuous profiler).
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { initDatadog } from './analytics/datadog';

import { startTelemetry } from './analytics/telemetry';

import { AppModule } from './app.module';
import { attachTerminalWebSocket } from './kubernetes/terminal.gateway';
import { OtelConsoleLogger } from './analytics/otel-logger';
import { AnalyticsService } from './analytics/analytics.service';
import { AnalyticsExceptionFilter } from './analytics/exception.filter';
import { ProtectionService } from './auth/protection.service';

// dotenv MUST run before telemetry so POSTHOG_API_KEY is available, and
// telemetry MUST run before Nest is imported so OTel instrumentation hooks
// are installed before any application code emits a log.
dotenv.config();
const envPath1 = resolve(process.cwd(), '..', '.env');
dotenv.config({ path: envPath1, override: false });
const envPath2 = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath2, override: false });
initDatadog();
startTelemetry();

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function() {
  return this.toString();
};

async function bootstrap() {
  // bodyParser: false — parsers are registered manually below AFTER the
  // protection proxy middleware. The proxy streams request bodies verbatim
  // to tenant upstreams; a parser in front of it would consume the stream
  // and every proxied POST would arrive empty.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bodyParser: false, logger: new OtelConsoleLogger() });

  const protectionService = app.get(ProtectionService);
  app.use(async (req, res, next) => {
    try {
      const handled = await protectionService.handleProxyRequest(req, res);
      if (!handled) return next();
    } catch {
      if (!res.headersSent) next();
    }
  });

  // Raise the body-parser limit above Express's 100kb default. GitHub App
  // webhooks (POST /apiv1/github/app/webhook) deliver push/installation
  // payloads that routinely exceed 100kb, and GitHub caps deliveries at 25MB.
  // Below 25MB the JSON parser threw PayloadTooLargeError (HTTP 413) before
  // the handler ran, so signature verification never happened and GitHub
  // marked the delivery failed. With bodyParser disabled at create() these
  // are the only json/urlencoded parsers; Nest still applies rawBody capture
  // (verify hook) so webhook HMAC verification keeps working.
  app.useBodyParser('json', { limit: '25mb' });
  app.useBodyParser('urlencoded', { limit: '25mb', extended: true });

  app.setGlobalPrefix('apiv1');

  // Forward unhandled exceptions to PostHog Error Tracking. Registered after
  // app creation so HttpAdapterHost is resolvable for the BaseExceptionFilter.
  const { httpAdapter } = app.get(HttpAdapterHost);
  const analytics = app.get(AnalyticsService);
  app.useGlobalFilters(new AnalyticsExceptionFilter(analytics, httpAdapter));

  // Configure trust proxy so req.ip honors X-Forwarded-For. Defaults to 1
  // (single trusted hop: Traefik in cluster, harmless in dev where no proxy
  // sets XFF). TRUST_PROXY accepts a hop count ("1", "2"),
  // "loopback"/"linklocal"/"uniquelocal", or a CIDR list. Set to "0" or
  // "false" to disable when running directly exposed.
  const trustProxy = process.env.TRUST_PROXY ?? '1';
  if (trustProxy && trustProxy !== '0' && trustProxy.toLowerCase() !== 'false') {
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
  // Protected-host websocket upgrades (e.g. graphql-ws on a tenant app) are
  // tunneled by the protection service; everything else falls through to the
  // terminal gateway's own upgrade listener.
  httpServer.on('upgrade', (req, socket, head) => {
    protectionService.handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  attachTerminalWebSocket(httpServer, app);

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}

bootstrap();

