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
import { execSessionEngine } from './kubernetes/exec-session-engine';
import { OtelConsoleLogger } from './analytics/otel-logger';
import { AnalyticsService } from './analytics/analytics.service';
import { AnalyticsExceptionFilter } from './analytics/exception.filter';
import { TelemetryService } from './telemetry/telemetry.service';
import { ProtectionService } from './auth/protection.service';
import { requestAuthStorage } from './auth/request-context';
import { loadGrafts } from './grafts/loader';
import { createWithGrafts, installApiAliases } from './grafts/boot';
import { GraftHttpRegistry } from './grafts/http-registry';

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

// oxlint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  await loadGrafts();
  const app = await createWithGrafts((grafts) =>
    NestFactory.create<NestExpressApplication>(AppModule.withGrafts(grafts), {
      rawBody: true,
      bodyParser: false,
      abortOnError: false,
      logger: new OtelConsoleLogger()
    })
  );

  app.enableShutdownHooks();

  const protectionService = app.get(ProtectionService);
  const graftHttp = app.get(GraftHttpRegistry);
  app.use(async (req, res, next) => {
    try {
      const handled = await graftHttp.handleRequest(req, res);
      if (!handled) return next();
    } catch {
      if (!res.headersSent) res.status(502).end();
    }
  });
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
  // The type list matters for SCIM: RFC 7644 puts request bodies on
  // application/scim+json, which every IdP sends. Express's json parser only
  // claims application/json by default, so those bodies arrived unparsed and
  // POST /scim/v2/Users saw an empty object.
  app.useBodyParser('json', {
    limit: '25mb',
    type: ['application/json', 'application/scim+json']
  });
  app.useBodyParser('urlencoded', { limit: '25mb', extended: true });

  app.setGlobalPrefix('apiv1');

  // Forward unhandled exceptions to PostHog Error Tracking. Registered after
  // app creation so HttpAdapterHost is resolvable for the BaseExceptionFilter.
  const { httpAdapter } = app.get(HttpAdapterHost);
  const analytics = app.get(AnalyticsService);
  app.useGlobalFilters(
    new AnalyticsExceptionFilter(analytics, httpAdapter, app.get(TelemetryService))
  );

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
  installApiAliases(app);

  // Own the request's auth context from the very first middleware frame.
  //
  // The guard used to establish this with AsyncLocalStorage.enterWith(), which
  // is not reliable from inside a guard: the handler often resumes on a context
  // captured before the guard ran, and getStore() comes back undefined. That
  // silently disabled every restriction published this way — project-scoped API
  // tokens as well as org-scoped sessions. Running the whole request inside
  // run() and letting the guard mutate this object keeps it visible everywhere.
  app.use((_req: unknown, _res: unknown, next: () => void) => {
    requestAuthStorage.run({}, next);
  });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  // Hosts that are part of the platform itself (login, status page, docs,
  // etc.) and may issue credentialed requests to the API. Comma-separated
  // origins, e.g. `https://app.orchard.my,https://docs.orchard.my`.
  const platformOrigins = new Set<string>([
    frontendUrl,
    ...(process.env.PLATFORM_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ]);

  const corsForPlatform = {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      // No-origin requests (curl, server-to-server) cannot ride a session
      // cookie cross-origin, so accepting them is harmless.
      if (!origin) return callback(null, true);

      if (platformOrigins.has(origin)) return callback(null, true);

      // Deliberately no `*.BASE_DOMAIN` wildcard: tenant-hosted apps live
      // under the same apex as platform infra in some configurations, and
      // a credentialed CORS match would let a tenant's JS read API
      // responses on behalf of a logged-in user. If you need to allow
      // additional first-party origins, add them to PLATFORM_ORIGINS.
      // Declined rather than thrown: the browser withholds the response
      // either way, and a cookie-backed mutation is refused with a real 403
      // by SuperAdminGuard instead of a 500 from here.
      callback(null, false);
    },
    credentials: true
  };
  // A public status page is read from its own host by anyone, with no
  // session, so it gets an open origin with credentials off. Everything
  // else keeps the platform allowlist and credentials on.
  app.enableCors((req: { url?: string }, callback) => {
    if ((req.url ?? '').startsWith('/apiv1/status/')) {
      callback(null, { origin: true, credentials: false, methods: ['GET'] });
      return;
    }
    callback(null, corsForPlatform);
  });

  const port = process.env.PORT || 3001;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);

  // Attach WebSocket terminal handler to the underlying HTTP server
  const httpServer = app.getHttpServer();
  httpServer.on('upgrade', (req, socket, head) => {
    graftHttp
      .handleUpgrade(req, socket, head)
      .then((handled) => {
        if (handled) return;
        return protectionService.handleUpgrade(req, socket, head).then(() => undefined);
      })
      .catch(() => socket.destroy());
  });
  const isGraftUpgrade = (req: { url?: string; headers: { host?: string } }) =>
    graftHttp.isHostRouted(req.headers.host) || graftHttp.claimsUpgradePath(req.url);
  execSessionEngine(httpServer, app, { skipUpgrade: isGraftUpgrade });
  attachTerminalWebSocket(httpServer, app);
  await graftHttp.listening(httpServer);

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}

bootstrap();
