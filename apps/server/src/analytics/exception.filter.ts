import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpServer,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request, Response } from 'express';
import { AnalyticsService } from './analytics.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { markSpanError } from './datadog';
import { redactSensitivePath } from './url-redaction';
import { getClientIp } from '../auth/client-ip';
import { k8sHttpException } from '../kubernetes/k8s-error';
import { prismaHttpException } from '../prisma/prisma-error';

/**
 * Global filter that forwards every unhandled error to PostHog Error
 * Tracking. We extend BaseExceptionFilter so Nest still produces the
 * standard JSON error response: we only add the analytics side-effect.
 *
 * 4xx HttpExceptions are skipped: they're expected-validation noise and
 * would drown out real bugs in the dashboard.
 */
@Catch()
export class AnalyticsExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AnalyticsExceptionFilter.name);

  constructor(
    private readonly analytics: AnalyticsService,
    applicationRef?: HttpServer,
    private readonly telemetry?: TelemetryService
  ) {
    super(applicationRef);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // The k8s client's opaque 'HTTP request failed' would otherwise be what the
    // caller sees. Report the original (it carries the stack), respond with the
    // unwrapped one.
    const malformedId = prismaHttpException(exception);
    const normalized = k8sHttpException(exception) ?? malformedId ?? exception;

    try {
      if (host.getType() === 'http') {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<
          Request & { auth?: { userId?: string }; user?: { sub?: string } }
        >();
        const res = ctx.getResponse<Response>();
        const status =
          normalized instanceof HttpException
            ? normalized.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;
        // An unwrapped k8s error can land on a 4xx, but it is still a bug we
        // never handled, so it stays in Error Tracking.
        if (status >= 500 || (!(exception instanceof HttpException) && !malformedId)) {
          // Nest swallows the exception before express sees it, so without
          // this Datadog Error Tracking only gets a bare 500 status.
          markSpanError(exception);
          const distinctId = req.auth?.userId || req.user?.sub || `ip:${getClientIp(req)}`;
          this.analytics.captureException(exception, distinctId, {
            http_method: req.method,
            http_path: req.route?.path ?? redactSensitivePath(req.url),
            http_status: status,
            user_agent: req.headers['user-agent'] ?? null
          });
          this.telemetry?.captureException(exception, {
            method: req.method,
            route: req.route?.path,
            status
          });
        }
        void res;
      } else {
        markSpanError(exception);
        this.analytics.captureException(exception, 'background', {
          context_type: host.getType()
        });
        this.telemetry?.captureException(exception, { contextType: host.getType() });
      }
    } catch (e) {
      this.logger.warn(`forward to analytics failed: ${(e as Error).message}`);
    }

    super.catch(normalized, host);
  }
}
