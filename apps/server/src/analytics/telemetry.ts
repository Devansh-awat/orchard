/**
 * OpenTelemetry logs bootstrap. Wired into PostHog Logs via OTLP/HTTP.
 *
 * Must be imported FIRST in main.ts (before Nest, before any application
 * code) so instrumentation is in place before modules start logging.
 *
 * Disabled when POSTHOG_API_KEY is unset — useful for local dev where you
 * don't want every console.log shipped to PostHog.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

let sdk: NodeSDK | null = null;

export function startTelemetry(): void {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return;

  const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
  // PostHog Logs OTLP endpoint. See docs/logs/installation/nodejs.
  const endpoint = process.env.POSTHOG_OTLP_LOGS_ENDPOINT || `${host}/i/v1/logs`;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'orchard-server',
      'service.namespace': 'orchard',
      'deployment.environment': process.env.NODE_ENV || 'development',
    }),
    logRecordProcessor: new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: endpoint,
        headers: { Authorization: `Bearer ${key}` },
      }),
    ),
  });

  sdk.start();

  // Graceful flush on shutdown so we don't lose the last batch of logs.
  // IMPORTANT: registering a SIGTERM/SIGINT listener disables Node's default
  // terminate-on-signal behavior, so we MUST exit ourselves once the flush
  // finishes — otherwise the process ignores SIGTERM entirely and `nest
  // start --watch` restarts hang forever on stale code.
  const shutdown = (signal: NodeJS.Signals) => {
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref();
    Promise.resolve(sdk?.shutdown())
      .catch((err) => console.warn(`OTel shutdown failed: ${(err as Error).message}`))
      .finally(() => process.exit(signal === 'SIGINT' ? 130 : 0));
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
  verbose: SeverityNumber.TRACE,
};

export function emitLog(level: string, message: string, attributes?: Record<string, unknown>) {
  if (!sdk) return;
  try {
    logs.getLogger('orchard-server').emit({
      severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: message,
      attributes: attributes as Record<string, string | number | boolean>,
    });
  } catch {
    // never let logging crash the app
  }
}
