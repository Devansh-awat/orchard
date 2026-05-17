import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpServer } from '@nestjs/core';
import { Request, Response } from 'express';
import { AnalyticsService } from './analytics.service';

/**
 * Global filter that forwards every unhandled error to PostHog Error
 * Tracking. We extend BaseExceptionFilter so Nest still produces the
 * standard JSON error response — we only add the analytics side-effect.
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
  ) {
    super(applicationRef);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    try {
      if (host.getType() === 'http') {
        const ctx = host.switchToHttp();
        const req = ctx.getRequest<Request & { auth?: { userId?: string }; user?: { sub?: string } }>();
        const res = ctx.getResponse<Response>();
        const status =
          exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
        if (status >= 500) {
          const distinctId = req.auth?.userId || req.user?.sub || `ip:${req.ip ?? 'unknown'}`;
          this.analytics.captureException(exception, distinctId, {
            http_method: req.method,
            http_path: req.route?.path ?? req.url,
            http_status: status,
            user_agent: req.headers['user-agent'] ?? null,
          });
        }
        void res;
      } else {
        this.analytics.captureException(exception, 'background', {
          context_type: host.getType(),
        });
      }
    } catch (e) {
      this.logger.warn(`forward to analytics failed: ${(e as Error).message}`);
    }

    super.catch(exception, host);
  }
}
