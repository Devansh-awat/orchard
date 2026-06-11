/**
 * Datadog APM bootstrap: distributed tracing, continuous profiler, runtime
 * metrics, and trace/log correlation via dd-trace.
 *
 * Must be called from main.ts AFTER dotenv (needs the DD_* env vars) but
 * BEFORE Nest/express/prisma are imported — dd-trace patches modules as they
 * are required, so anything loaded before init() is invisible to APM.
 *
 * Off by default: only activates when the deployment points it at an agent
 * (DD_AGENT_HOST / DD_TRACE_AGENT_URL, set by the helm chart) or when
 * DD_TRACE_ENABLED=true is set explicitly. Local dev stays silent.
 */
import tracer from 'dd-trace';

export function initDatadog(): void {
  if (process.env.DD_TRACE_ENABLED === 'false') return;
  const hasAgent = !!(process.env.DD_AGENT_HOST || process.env.DD_TRACE_AGENT_URL);
  if (!hasAgent && process.env.DD_TRACE_ENABLED !== 'true') return;

  tracer.init({
    env: process.env.DD_ENV || process.env.NODE_ENV || 'development',
    service: process.env.DD_SERVICE || 'orchard-server',
    version: process.env.DD_VERSION,
    // Correlate logs with traces (adds dd.trace_id to supported loggers).
    logInjection: true,
    // Event loop lag, heap, GC pauses → service Runtime Metrics tab.
    runtimeMetrics: true,
    // Continuous Profiler: wall/CPU/heap profiles via @datadog/pprof.
    profiling: process.env.DD_PROFILING_ENABLED !== 'false',
  });
}

/**
 * Attach an exception to the active APM span so Datadog Error Tracking gets
 * the real error type/message/stack instead of a bare HTTP 500. Safe to call
 * when tracing is disabled (no active span → no-op).
 */
export function markSpanError(exception: unknown): void {
  try {
    const span = tracer.scope().active();
    if (!span) return;
    span.setTag(
      'error',
      exception instanceof Error ? exception : new Error(String(exception)),
    );
  } catch {
    /* never let telemetry break request handling */
  }
}
