import './instrument';
import 'reflect-metadata';
import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { registerBodyParsers } from './http/body-limits';
import { trustProxySetting } from './auth/client-ip';
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

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  registerBodyParsers((type, options) => app.useBodyParser(type, options));

  app.setGlobalPrefix('apiv1');

  // Forward unhandled exceptions to PostHog Error Tracking. Registered after
  // app creation so HttpAdapterHost is resolvable for the BaseExceptionFilter.
  const { httpAdapter } = app.get(HttpAdapterHost);
  const analytics = app.get(AnalyticsService);
  app.useGlobalFilters(
    new AnalyticsExceptionFilter(analytics, httpAdapter, app.get(TelemetryService))
  );

  const trustProxy = trustProxySetting();
  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  app.use(cookieParser());
  installApiAliases(app);

  // Own the request's auth context from the very first middleware frame.
  //
  // AsyncLocalStorage.enterWith() is not reliable from inside a guard: the handler
  // often resumes on a context captured before the guard ran, and getStore() comes
  // back undefined. That would silently disable every restriction published this
  // way, project-scoped API tokens as well as org-scoped sessions. Running the
  // whole request inside run() and letting the guard mutate this object keeps it
  // visible everywhere.
  app.use((_req: unknown, _res: unknown, next: () => void) => {
    requestAuthStorage.run({}, next);
  });

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  // Hosts that are part of the platform itself (login, status page, docs,
  // etc.) and may issue credentialed requests to the API. Comma-separated
  // origins, e.g. `https://app.orchard.my,https://docs.orchard.hackclub.com`.
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
