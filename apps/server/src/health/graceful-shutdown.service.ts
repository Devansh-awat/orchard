import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server } from 'http';

const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS) || 5000;

@Injectable()
export class GracefulShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdownService.name);
  draining = false;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  beforeApplicationShutdown(signal?: string) {
    if (this.draining) return;
    this.draining = true;
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.logger.log(
      `draining after ${signal ?? 'shutdown'}: long-lived connections close in ${DRAIN_MS}ms`
    );
    server.closeIdleConnections?.();
    const timer = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    timer.unref();
  }
}
