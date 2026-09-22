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
    profiling: process.env.DD_PROFILING_ENABLED !== 'false'
  });
}

/**
 * Heuristic: did the build fail because of the user's code/config, or
 * because of our infrastructure? Tagged on the build span so dashboards can
 * separate "their Dockerfile is broken" from "our builders are broken".
 */
const USER_ERROR_RE =
  /dockerfile|failed to parse|syntax error|npm err|yarn|pnpm|tsc |compil|did not complete successfully|exit code: [1-9]|executor failed|unable to find|no such file|fatal: |authentication failed|repository not found|railpack/i;
const SYSTEM_ERROR_RE =
  /timed? ?out|scheduling|insufficient|quota|registry|failed to push|econnrefused|enotfound|etimedout|socket hang up|daemon|buildkit|pvc|disk full|no space|s3|tls|internal server|pool/i;

export function classifyBuildError(message: string, step?: string): 'user' | 'system' | 'unknown' {
  const text = `${step ?? ''} ${message}`;
  if (USER_ERROR_RE.test(text)) return 'user';
  if (SYSTEM_ERROR_RE.test(text)) return 'system';
  return 'unknown';
}

/**
 * One APM trace per image build, on its own `orchard-builds` service so the
 * Service Catalog shows build throughput/duration/error-rate separately from
 * API traffic. Works even when tracing is disabled (dd-trace returns no-op
 * spans before init), so callers never need to guard.
 */
export function startBuildTrace(meta: {
  deploymentId: string;
  deploymentName: string;
  namespace: string;
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  buildType?: string;
  triggerType?: string;
  triggeredById?: string;
  isRebuild?: boolean;
}) {
  const repo = meta.repoUrl?.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  const span = tracer.startSpan('build.pipeline', {
    tags: {
      'service.name': 'orchard-builds',
      'resource.name': repo ? `${repo}@${meta.branch ?? 'main'}` : meta.deploymentName,
      'span.kind': 'internal',
      'build.deployment_id': meta.deploymentId,
      'build.deployment_name': meta.deploymentName,
      'build.namespace': meta.namespace,
      'build.repo': repo,
      'build.branch': meta.branch,
      'build.commit_sha': meta.commitSha,
      'build.type': meta.buildType ?? 'dockerfile',
      'build.trigger': meta.triggerType ?? 'manual',
      'build.triggered_by': meta.triggeredById,
      'build.is_rebuild': !!meta.isRebuild
    }
  });

  let finished = false;
  return {
    /**
     * Run `fn` with this build span as the active trace context, so spans
     * created downstream (build.schedule, instrumented k8s/registry HTTP
     * calls) attach to the build trace instead of floating free.
     */
    activate<T>(fn: () => Promise<T>): Promise<T> {
      try {
        return tracer.scope().activate(span, fn);
      } catch {
        return fn();
      }
    },
    /** Mark the pipeline successful. Extra tags: e.g. image build seconds. */
    finishSuccess(tags?: Record<string, string | number | boolean | undefined>) {
      if (finished) return;
      finished = true;
      try {
        if (tags) span.addTags(tags as Record<string, string>);
        span.setTag('build.outcome', 'succeeded');
        span.finish();
      } catch {
        /* telemetry must never break builds */
      }
    },
    /** Mark the pipeline failed; classifies user-vs-system from the error. */
    finishFailure(error: unknown, step?: string) {
      if (finished) return;
      finished = true;
      try {
        const err = error instanceof Error ? error : new Error(String(error));
        span.setTag('error', err);
        span.setTag('build.outcome', 'failed');
        span.setTag('build.failed_step', step ?? 'unknown');
        span.setTag('build.error_domain', classifyBuildError(err.message, step));
        span.finish();
      } catch {
        /* telemetry must never break builds */
      }
    }
  };
}

/**
 * Child span for a phase inside the build pipeline (e.g. `build.schedule`:
 * k8s Job submitted → pod running). Parents to the active trace context when
 * one exists, otherwise stands alone. Finish is idempotent.
 */
export function startPhaseSpan(
  name: string,
  tags?: Record<string, string | number | boolean | undefined>
) {
  const span = tracer.startSpan(name, {
    childOf: tracer.scope().active() ?? undefined,
    tags: {
      'service.name': 'orchard-builds',
      'resource.name': name,
      ...tags
    }
  });
  let finished = false;
  return {
    finish(extra?: Record<string, string | number | boolean | undefined>) {
      if (finished) return;
      finished = true;
      try {
        if (extra) span.addTags(extra as Record<string, string>);
        span.finish();
      } catch {
        /* telemetry must never break builds */
      }
    }
  };
}

/**
 * Record an already-completed phase as a span with explicit start/end times
 * (e.g. build pod container timings reported by Kubernetes after the fact).
 * No-op for invalid/zero-length windows.
 */
export function recordPhaseSpan(
  name: string,
  startMs: number,
  endMs: number,
  tags?: Record<string, string | number | boolean | undefined>
): void {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
  try {
    const span = tracer.startSpan(name, {
      childOf: tracer.scope().active() ?? undefined,
      startTime: startMs,
      tags: {
        'service.name': 'orchard-builds',
        'resource.name': name,
        ...tags
      }
    });
    span.finish(endMs);
  } catch {
    /* telemetry must never break builds */
  }
}

export type BuildOutcomeSource = 'watch' | 'resume' | 'recovery' | 'queue';

export type BuildOutcomeReason =
  | 'build_error'
  | 'unschedulable'
  | 'pod_start_failed'
  | 'job_missing'
  | 'job_deleted'
  | 'job_never_created'
  | 'watch_timeout'
  | 'image_unknown'
  | 'k8s_missing'
  | 'internal'
  | 'none';

export function recordBuildOutcome(meta: {
  outcome: 'succeeded' | 'failed' | 'timeout';
  source: BuildOutcomeSource;
  reason?: BuildOutcomeReason;
  deploymentId: string;
  deploymentName?: string;
  projectId?: string;
  namespace?: string;
  jobName?: string;
  buildType?: string;
  durationMs?: number;
  lastPhase?: string;
  suppressed?: boolean;
  detail?: string;
}): void {
  const reason = meta.reason ?? 'none';
  const lastPhase = meta.lastPhase ?? 'unknown';
  try {
    const metricTags = [
      `outcome:${meta.outcome}`,
      `source:${meta.source}`,
      `reason:${reason}`,
      `last_phase:${lastPhase}`,
      `build_type:${meta.buildType ?? 'dockerfile'}`,
      `suppressed:${!!meta.suppressed}`
    ];
    const statsd = (
      tracer as unknown as {
        dogstatsd?: {
          increment(name: string, value?: number, tags?: string[]): void;
          distribution(name: string, value: number, tags?: string[]): void;
        };
      }
    ).dogstatsd;
    statsd?.increment('orchard.build.outcome', 1, metricTags);
    if (typeof meta.durationMs === 'number' && Number.isFinite(meta.durationMs)) {
      statsd?.distribution('orchard.build.duration_ms', meta.durationMs, metricTags);
    }
  } catch {
    /* telemetry must never break builds */
  }

  try {
    const span = tracer.startSpan('build.outcome', {
      childOf: tracer.scope().active() ?? undefined,
      tags: {
        'service.name': 'orchard-builds',
        'resource.name': `build.outcome.${meta.outcome}`,
        'build.outcome': meta.outcome,
        'build.outcome_source': meta.source,
        'build.outcome_reason': reason,
        'build.last_phase': lastPhase,
        'build.suppressed': !!meta.suppressed,
        'build.deployment_id': meta.deploymentId,
        'build.deployment_name': meta.deploymentName,
        'build.project_id': meta.projectId,
        'build.namespace': meta.namespace,
        'build.job_name': meta.jobName,
        'build.type': meta.buildType,
        'build.duration_ms': meta.durationMs,
        'build.detail': meta.detail?.slice(0, 4000)
      }
    });
    if (meta.outcome !== 'succeeded' && !meta.suppressed) {
      span.setTag(
        'error',
        new Error(meta.detail?.slice(0, 500) || `build ${meta.outcome}: ${reason}`)
      );
    }
    span.finish();
  } catch {
    /* telemetry must never break builds */
  }
}

/**
 * Every pass the build recovery sweep takes over a stuck build, with the facts
 * it decided on. This exists because the failure it used to produce was
 * invisible: the reason was written to a Postgres column and appended to build
 * logs, and nowhere else, so "Build job not found after server restart" could
 * not be found in Datadog at all — not as a log line, not as a metric, not as
 * a span. There was no way to ask how often it fired or what it saw.
 *
 * Emitted on every decision, not just failures, so the denominator is there:
 * `defer` dominating is healthy, `fail` climbing is not, and the tags say
 * which fact drove it.
 */
export function recordRecoveryDecision(meta: {
  action: string;
  reason: string;
  deploymentId: string;
  deploymentName?: string;
  namespace?: string;
  buildStep?: string | null;
  jobName?: string | null;
  /** How many jobs the cluster listed; -1 when it did not answer. */
  jobCount: number;
  informerHealthy: boolean;
  /** Age of the build when the sweep looked, in ms. */
  buildAgeMs?: number | null;
  hadBuildingRun: boolean;
  detail?: string;
}): void {
  try {
    const tags = [
      `action:${meta.action}`,
      `reason:${meta.reason}`,
      `build_step:${meta.buildStep ?? 'unknown'}`,
      `informer:${meta.informerHealthy ? 'healthy' : 'unhealthy'}`,
      `had_building_run:${meta.hadBuildingRun}`
    ];
    const statsd = (
      tracer as unknown as {
        dogstatsd?: {
          increment(name: string, value?: number, tags?: string[]): void;
          distribution(name: string, value: number, tags?: string[]): void;
        };
      }
    ).dogstatsd;
    statsd?.increment('orchard.build.recovery.decision', 1, tags);
    if (typeof meta.buildAgeMs === 'number' && Number.isFinite(meta.buildAgeMs)) {
      statsd?.distribution('orchard.build.recovery.build_age_ms', meta.buildAgeMs, tags);
    }
  } catch {
    /* telemetry must never break recovery */
  }

  try {
    const span = tracer.startSpan('build.recovery', {
      childOf: tracer.scope().active() ?? undefined,
      tags: {
        'service.name': 'orchard-builds',
        'resource.name': `build.recovery.${meta.action}`,
        'recovery.action': meta.action,
        'recovery.reason': meta.reason,
        'recovery.job_count': meta.jobCount,
        'recovery.informer_healthy': meta.informerHealthy,
        'recovery.had_building_run': meta.hadBuildingRun,
        'recovery.build_age_ms': meta.buildAgeMs ?? undefined,
        'build.deployment_id': meta.deploymentId,
        'build.deployment_name': meta.deploymentName,
        'build.namespace': meta.namespace,
        'build.last_phase': meta.buildStep ?? 'unknown',
        'build.job_name': meta.jobName ?? undefined,
        'build.detail': meta.detail?.slice(0, 4000)
      }
    });
    // Only a decision that ends a build the user did not ask to end is an
    // error. Adopting, deferring and requeueing are the sweep working.
    if (meta.action === 'fail') {
      span.setTag('error', new Error(meta.detail || `build recovery failed: ${meta.reason}`));
    }
    span.finish();
  } catch {
    /* telemetry must never break recovery */
  }
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
    span.setTag('error', exception instanceof Error ? exception : new Error(String(exception)));
  } catch {
    /* never let telemetry break request handling */
  }
}
