import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post
} from '@nestjs/common';
import {
  Auth,
  Doors,
  GraftUserId,
  type AuditDoor,
  type DbDoor,
  type SettingsDoor
} from '@orchard/graft-sdk/server';

type Announcement = {
  id: string;
  body: string;
  tone: 'info' | 'success' | 'warning';
  createdAt: string;
  expiresAt: string | null;
  author: string | null;
};

const TONES = new Set(['info', 'success', 'warning']);

@Controller('announcements')
export class AnnouncementsController {
  constructor(
    @Inject(Doors.db) private readonly db: DbDoor,
    @Inject(Doors.audit) private readonly audit: AuditDoor,
    @Inject(Doors.settings) private readonly settings: SettingsDoor
  ) {}

  private limit(): number {
    const raw = Number(this.settings.value('display', 'maxShown') ?? 3);
    return Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.floor(raw))) : 3;
  }

  @Get()
  @Auth()
  async active(): Promise<Announcement[]> {
    const { rows } = await this.db.query<Announcement>(
      `SELECT a.id, a.body, a.tone, a.created_at AS "createdAt", a.expires_at AS "expiresAt", u.username AS author
         FROM announcements a
         LEFT JOIN public.users u ON u.id = a.created_by
        WHERE a.expires_at IS NULL OR a.expires_at > now()
        ORDER BY a.pinned DESC, a.created_at DESC
        LIMIT $1`,
      [this.limit()]
    );
    return rows;
  }

  @Post()
  async create(
    @GraftUserId() userId: string,
    @Body() body: { body?: string; tone?: string; expiresInHours?: number }
  ): Promise<Announcement> {
    const text = (body.body ?? '').trim();
    if (!text || text.length > 500)
      throw new BadRequestException('Write between 1 and 500 characters');
    const tone = TONES.has(body.tone ?? '') ? body.tone : 'info';
    const hours = Number(body.expiresInHours ?? 0);
    const { rows } = await this.db.query<Announcement>(
      `INSERT INTO announcements (body, tone, created_by, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $4::int > 0 THEN now() + make_interval(hours => $4::int) END)
       RETURNING id, body, tone, created_at AS "createdAt", expires_at AS "expiresAt", NULL AS author`,
      [text, tone, userId, Number.isFinite(hours) ? Math.max(0, Math.floor(hours)) : 0]
    );
    await this.audit.log({
      action: 'announcements.created',
      actorUserId: userId,
      targetType: 'announcement',
      targetId: rows[0].id,
      targetLabel: text.slice(0, 80)
    });
    return rows[0];
  }

  @Delete(':id')
  async remove(
    @GraftUserId() userId: string,
    @Param('id') id: string
  ): Promise<{ removed: boolean }> {
    const { rowCount } = await this.db.query('DELETE FROM announcements WHERE id = $1', [id]);
    if (rowCount) {
      await this.audit.log({
        action: 'announcements.removed',
        actorUserId: userId,
        targetType: 'announcement',
        targetId: id
      });
    }
    return { removed: !!rowCount };
  }
}
