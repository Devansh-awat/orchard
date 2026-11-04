import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  MessageEvent,
  Param,
  Query,
  Request,
  Res,
  ServiceUnavailableException,
  Sse
} from '@nestjs/common';
import type { Response } from 'express';
import {
  Observable,
  finalize,
  from,
  interval,
  startWith,
  switchMap,
  takeUntil,
  filter,
  map
} from 'rxjs';
import { SseStreamLimiter } from '../events/sse-stream-limiter';
import { RequestsService, type RequestRow } from './requests.service';
import { LogsStoreError } from './victoria-logs.service';
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
    private readonly requests: RequestsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly streams: SseStreamLimiter
  ) {}

  @Get('deployments/:id/requests')
  async getRequests(
    @Param('id') id: string,
    @Request() req,
    @Query('view') view?: string,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('limit') limitStr?: string,
    @Query('method') methodStr?: string,
    @Query('status') statusStr?: string,
    @Query('path') pathStr?: string,
    @Query('client') clientStr?: string,
    @Query('minMs') minMsStr?: string
  ) {
    await this.assertLogAccess(id, req);
    if (!this.requests.available) {
      throw new ServiceUnavailableException("No log store is set up, so requests aren't recorded");
    }
    const { start, end } = parseRange(startStr, endStr);
    const n = Math.min(Math.max(Number(limitStr) || 0, 1), 500);
    try {
      switch (view ?? 'routes') {
        case 'routes':
          return { routes: await this.requests.routes(id, start, end, Number(limitStr) ? n : 50) };
        case 'slowest':
          return {
            requests: await this.requests.slowest(id, start, end, Number(limitStr) ? n : 20)
          };
        case 'recent':
          return {
            requests: await this.requests.recent(id, start, end, Number(limitStr) ? n : 100, {
              methods: (methodStr ?? '')
                .split(',')
                .map((m) => m.trim().toUpperCase())
                .filter(Boolean),
              statusClasses: (statusStr ?? '')
                .split(',')
                .map((c) => Number.parseInt(c, 10))
                .filter((c) => Number.isInteger(c)),
              path: pathStr,
              client: clientStr,
              minMs: Number(minMsStr) || undefined
            })
          };
        case 'clients':
          return await this.requests.clients(id, start, end, Number(limitStr) ? n : 10);
        default:
          throw new BadRequestException('view must be routes, slowest, recent or clients');
      }
    } catch (err) {
      if (err instanceof LogsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Sse('deployments/:id/requests/stream')
  async streamRequests(@Param('id') id: string, @Request() req): Promise<Observable<MessageEvent>> {
    await this.assertLogAccess(id, req);
    if (!this.requests.available) {
      throw new ServiceUnavailableException("No log store is set up, so requests aren't recorded");
    }
    const release = this.streams.acquire(req.user.sub, `requests:${id}`);
    let since = Date.now() - 60_000;
    let seen = new Set<string>();
    const key = (r: RequestRow) => `${r.t}|${r.method}|${r.path}|${r.clientIp}|${r.status}`;
    return interval(2_000).pipe(
      startWith(0),
      switchMap(() =>
        from(this.requests.recent(id, since, Date.now(), 200).catch(() => [] as RequestRow[]))
      ),
      map((rows) => {
        const fresh = rows.filter((r) => !seen.has(key(r))).reverse();
        if (rows.length) {
          const newest = Date.parse(rows[0].t);
          if (Number.isFinite(newest)) since = Math.max(since, newest - 5_000);
          seen = new Set(rows.map(key));
        }
        return fresh;
      }),
      filter((fresh) => fresh.length > 0),
      map((fresh) => ({ data: { requests: fresh } }) as MessageEvent),
      takeUntil(this.streams.untilAccessLost(req.auth, () => this.assertLogAccess(id, req))),
      finalize(release)
    );
  }

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
    const clamp = (v: string | undefined) =>
      Math.min(Math.max(Number(v) || 60_000, 1_000), 60 * 60 * 1000);
    return this.logs.context(id, {
      at,
      pod: pod?.trim() || undefined,
      beforeMs: clamp(beforeStr),
      afterMs: clamp(afterStr)
    });
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
