/**
 * OpenTelemetry logs bootstrap. Wired into PostHog Logs via OTLP/HTTP.
 *
 * Must be imported FIRST in main.ts (before Nest, before any application
 * code) so instrumentation is in place before modules start logging.
 *
 * Disabled when POSTHOG_API_KEY is unset: useful for local dev where you
 * don't want every console.log shipped to PostHog.
 */
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const SHUTDOWN_DEADLINE_MS = 30_000;

let sdk: LoggerProvider | null = null;

export function startTelemetry(): void {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return;

  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
  // PostHog Logs OTLP endpoint. See docs/logs/installation/nodejs.
  const endpoint = process.env.POSTHOG_OTLP_LOGS_ENDPOINT || `${host}/i/v1/logs`;

  sdk = new LoggerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        'service.name': process.env.OTEL_SERVICE_NAME || 'orchard-server',
        'service.namespace': 'orchard',
        'deployment.environment': process.env.NODE_ENV || 'development'
      })
    ),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: endpoint,
          headers: { Authorization: `Bearer ${key}` }
        })
      })
    ]
  });
  logs.setGlobalLoggerProvider(sdk);

  // Flush on shutdown without racing Nest's own graceful close. Registering a
  // SIGTERM listener disables Node's default exit, so the first signal flushes
  // and arms a deadline, and the signal Nest re-sends once it has closed (or a
  // second one from the user) exits for real.
  let signalled = false;
  const shutdown = (signal: NodeJS.Signals) => {
    const code = signal === 'SIGINT' ? 130 : 0;
    if (signalled) {
      process.exit(code);
      return;
    }
    signalled = true;
    const forceExit = setTimeout(() => process.exit(code), SHUTDOWN_DEADLINE_MS);
    forceExit.unref();
    void Promise.resolve(sdk?.shutdown()).catch((err) =>
      console.warn(`OTel shutdown failed: ${(err as Error).message}`)
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Map Nest's log levels to OTel severity. Anything beyond fatal/error/warn/
 * info/debug/verbose is treated as info.
 */
const SEVERITY: Record<string, SeverityNumber> = {
  fatal: SeverityNumber.FATAL,
  error: SeverityNumber.ERROR,
  warn: SeverityNumber.WARN,
  log: SeverityNumber.INFO,
  info: SeverityNumber.INFO,
  debug: SeverityNumber.DEBUG,
  verbose: SeverityNumber.TRACE
};

export function emitLog(level: string, message: string, attributes?: Record<string, unknown>) {
  if (!sdk) return;
  try {
    logs.getLogger('orchard-server').emit({
      severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: message,
      attributes: attributes as Record<string, string | number | boolean>
    });
  } catch {
    // never let logging crash the app
  }
}
