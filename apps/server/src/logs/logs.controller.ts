import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Request,
  Res
} from '@nestjs/common';
import type { Response } from 'express';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { LogsService, type SearchParams } from './logs.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 31 * DAY_MS;

function list(raw: string | string[] | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = (Array.isArray(raw) ? raw : raw.split(',')).map((v) => v.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

export function parseRange(startStr?: string, endStr?: string, fallbackMs = 60 * 60 * 1000) {
  const end = Number(endStr) || Date.now();
  const start = Number(startStr) || end - fallbackMs;
  if (end <= start) throw new BadRequestException('end must be > start');
  if (end - start > MAX_RANGE_MS) throw new BadRequestException('range must be 31 days or less');
  return { start, end };
}

@Auth()
@Controller('observe')
export class LogsController {
  constructor(
    private readonly logs: LogsService,
    private readonly projectAccess: ProjectAccessService
  ) {}

  @Get('deployments/:id/logs/search')
  async search(
    @Param('id') id: string,
    @Request() req,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('q') q?: string,
    @Query('levels') levels?: string,
    @Query('pods') pods?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string
  ) {
    await this.assertLogAccess(id, req);
    return this.logs.search(id, this.params(start, end, q, levels, pods, limit, cursor));
  }

  @Get('deployments/:id/logs/levels')
  async levels(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string
  ) {
    await this.assertLogAccess(id, req);
    const { start, end } = parseRange(startStr, endStr);
    const stepMs = Math.max(15_000, Number(stepStr) || Math.round((end - start) / 60));
    return this.logs.levelCounts(id, { start, end, stepMs });
  }

  @Get('deployments/:id/logs/context')
  async context(
    @Param('id') id: string,
    @Request() req,
    @Query('at') atStr?: string,
    @Query('pod') pod?: string,
    @Query('before') beforeStr?: string,
    @Query('after') afterStr?: string
  ) {
    await this.assertLogAccess(id, req);
    const at = Number(atStr) || Date.parse(atStr ?? '');
    if (!Number.isFinite(at)) throw new BadRequestException('at must be a time');
    if (!pod) throw new BadRequestException('pod is required');
    const clamp = (v: string | undefined) =>
      Math.min(Math.max(Number(v) || 60_000, 1_000), 60 * 60 * 1000);
    return this.logs.context(id, { at, pod, beforeMs: clamp(beforeStr), afterMs: clamp(afterStr) });
  }

  @Get('deployments/:id/logs/export')
  async export(
    @Param('id') id: string,
    @Request() req,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('q') q?: string,
    @Query('levels') levels?: string,
    @Query('pods') pods?: string
  ) {
    await this.assertLogAccess(id, req);
    const kind = format === 'ndjson' ? 'ndjson' : 'text';
    const params = this.params(start, end, q, levels, pods);
    res.setHeader(
      'Content-Type',
      kind === 'ndjson' ? 'application/x-ndjson' : 'text/plain; charset=utf-8'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="logs-${new Date(params.end).toISOString().slice(0, 19)}.${kind === 'ndjson' ? 'ndjson' : 'log'}"`
    );
    for await (const chunk of this.logs.export(id, params, kind)) res.write(chunk);
    res.end();
  }

  private params(
    start?: string,
    end?: string,
    q?: string,
    levels?: string,
    pods?: string,
    limit?: string,
    cursor?: string
  ): SearchParams {
    const range = parseRange(start, end);
    return {
      ...range,
      q: q?.slice(0, 1000) || undefined,
      levels: list(levels),
      pods: list(pods),
      limit: Number(limit) || undefined,
      cursor: cursor || null
    };
  }

  private async assertLogAccess(deploymentId: string, req) {
    const scope = await this.projectAccess.assertDeploymentView(deploymentId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!scope.access.canEdit) throw new ForbiddenException('Logs need edit access to the project');
    return scope;
  }
}
