import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Request,
  BadRequestException,
  Sse,
  MessageEvent,
  ServiceUnavailableException,
  ForbiddenException
} from '@nestjs/common';
import { Observable, finalize, takeUntil } from 'rxjs';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { SseStreamLimiter } from '../events/sse-stream-limiter';
import { ObservabilityService } from './observability.service';
import { MetricsStoreError } from '../metrics/victoria-metrics.service';
import { ErrorIngestService } from './error-ingest.service';
import { TimelineService } from './timeline.service';
import { FindingsService } from './findings.service';
import { parseKinds } from './timeline-entries';

@Auth()
@Controller('observe')
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly errorIngest: ErrorIngestService,
    private readonly timeline: TimelineService,
    private readonly findings: FindingsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly streams: SseStreamLimiter
  ) {}

  @Get('deployments/:id/timeline')
  async getTimeline(
    @Param('id') id: string,
    @Request() req,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
    @Query('kinds') kinds?: string
  ) {
    const { access } = await this.assertAccess(id, req);
    return this.timeline.list(id, {
      cursor: cursor || null,
      limit: Number(limitStr) || undefined,
      kinds: parseKinds(kinds),
      canEdit: access.canEdit
    });
  }

  @Get('deployments/:id/changes')
  async getChanges(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string
  ) {
    const { access } = await this.assertAccess(id, req);
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 24 * 60 * 60 * 1000;
    if (end <= start) throw new BadRequestException('end must be > start');
    if (end - start > 31 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('range must be 31 days or less');
    }
    return this.timeline.changes(id, { start, end, canEdit: access.canEdit });
  }

  @Get('deployments/:id/findings')
  async getFindings(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('tz') tz?: string
  ) {
    const { access } = await this.assertAccess(id, req);
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 24 * 60 * 60 * 1000;
    if (end <= start) throw new BadRequestException('end must be > start');
    if (end - start > 8 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('range must be 8 days or less');
    }
    try {
      return await this.findings.findings(id, { start, end, tz, canEdit: access.canEdit });
    } catch (err) {
      if (err instanceof MetricsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Get('deployments/:id/capabilities')
  async getCapabilities(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.getCapabilities(id);
  }

  @Get('deployments/:id/http-metrics')
  async getHttpMetrics(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string
  ) {
    await this.assertAccess(id, req);
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 60 * 60 * 1000;
    const step = Math.max(1000, Number(stepStr) || 30_000);
    if (end <= start) throw new BadRequestException('end must be > start');
    try {
      return await this.observability.getHttpMetrics(id, start, end, step);
    } catch (err) {
      if (err instanceof MetricsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Get('deployments/:id/pod-health')
  async getPodHealth(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string
  ) {
    await this.assertAccess(id, req);
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 60 * 60 * 1000;
    const step = Math.max(30_000, Number(stepStr) || 60_000);
    if (end <= start) throw new BadRequestException('end must be > start');
    try {
      return await this.observability.getPodHealth(id, start, end, step);
    } catch (err) {
      if (err instanceof MetricsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Get('deployments/:id/volumes')
  async getVolumes(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.getVolumes(id);
  }

  @Get('deployments/:id/builds')
  async getBuildHistory(
    @Param('id') id: string,
    @Request() req,
    @Query('limit') limitStr?: string
  ) {
    await this.assertAccess(id, req);
    return this.observability.getBuildHistory(id, Number(limitStr) || 30);
  }

  @Sse('deployments/:id/build-logs/stream')
  async streamBuildLogs(
    @Param('id') id: string,
    @Request() req,
    @Query('offset') offsetStr?: string
  ): Promise<Observable<MessageEvent>> {
    await this.assertLogAccess(id, req);
    const lastEventId =
      typeof req.headers?.['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined;
    const offset = Math.max(0, Number(lastEventId ?? offsetStr) || 0);
    const release = this.streams.acquire(req.user.sub, `build-logs:${id}`);
    return this.observability
      .streamBuildLogs(id, offset)
      .pipe(
        takeUntil(this.streams.untilAccessLost(req.auth, () => this.assertLogAccess(id, req))),
        finalize(release)
      ) as Observable<MessageEvent>;
  }

  @Sse('deployments/:id/logs/stream')
  async streamRuntimeLogs(
    @Param('id') id: string,
    @Request() req,
    @Query('tailLines') tailLinesStr?: string,
    @Query('sinceTime') sinceTimeQuery?: string
  ): Promise<Observable<MessageEvent>> {
    await this.assertLogAccess(id, req);
    const tailLines = Math.min(Math.max(1, Number(tailLinesStr) || 100), 5000);
    const lastEventId =
      typeof req.headers?.['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined;
    const sinceTime = lastEventId || sinceTimeQuery || undefined;
    const release = this.streams.acquire(req.user.sub, `logs:${id}`);
    return this.observability
      .streamRuntimeLogs(id, tailLines, sinceTime)
      .pipe(
        takeUntil(this.streams.untilAccessLost(req.auth, () => this.assertLogAccess(id, req))),
        finalize(release)
      ) as Observable<MessageEvent>;
  }

  @Get('deployments/:id/logs/structured')
  async getStructuredLogs(
    @Param('id') id: string,
    @Request() req,
    @Query('tailLines') tailLinesStr?: string,
    @Query('level') level?: string,
    @Query('search') search?: string
  ) {
    await this.assertLogAccess(id, req);
    const tailLines = Math.min(Math.max(1, Number(tailLinesStr) || 200), 20000);
    return this.observability.getStructuredLogs(id, tailLines, level, search);
  }

  @Get('deployments/:id/overview')
  async getOverview(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.getOverview(id);
  }

  @Get('deployments/:id/runtime')
  async getRuntime(@Param('id') id: string, @Request() req) {
    await this.assertAccess(id, req);
    return this.observability.detectRuntime(id);
  }

  @Get('deployments/:id/errors')
  async getErrors(@Param('id') id: string, @Request() req, @Query('window') windowStr?: string) {
    await this.assertLogAccess(id, req);
    const window = Math.min(Math.max(1, Number(windowStr) || 60), 1440);
    return this.errorIngest.listGroups(id, window);
  }

  @Patch('deployments/:id/errors/:fingerprint')
  async updateError(
    @Param('id') id: string,
    @Param('fingerprint') fingerprint: string,
    @Body() body: { status?: string; assigneeId?: string | null },
    @Request() req
  ) {
    const { user, access } = await this.assertAccess(id, req);
    if (!access.canEdit) {
      throw new ForbiddenException('Editing error groups needs edit access to the project');
    }
    return this.errorIngest.updateGroup(id, fingerprint, body, user.id);
  }

  private async assertLogAccess(deploymentId: string, req) {
    const scope = await this.assertAccess(deploymentId, req);
    if (!scope.access.canEdit) {
      throw new ForbiddenException('Logs need edit access to the project');
    }
    return scope;
  }

  private assertAccess(deploymentId: string, req) {
    return this.projectAccess.assertDeploymentView(deploymentId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }
}
