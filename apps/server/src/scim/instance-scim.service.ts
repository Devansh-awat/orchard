import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UsersService, sanitizeUsername } from '../users/users.service';
import { ACCOUNT_SCOPE, accountEmail } from '../users/account-scope';
import { normalizeBoundedEmail } from '../auth/email-normalize';

const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const MAX_PAGE = 200;

export const INSTANCE_SCIM_PREFIX = 'iscim_';

export function hashInstanceScimToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function instanceScimError(status: number, detail: string, scimType?: string) {
  return new HttpException(
    { schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) },
    status
  );
}

type AccountRow = {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  disabledAt: Date | null;
  scimExternalId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  disabledAt: true,
  scimExternalId: true,
  createdAt: true,
  updatedAt: true
} as const;

/**
 * Provisioning for the instance's own directory: the operator's IdP creates,
 * renames and turns off **accounts** here. The instance is trusted, so this is
 * the one SCIM surface allowed to touch accounts; organization SCIM only ever
 * manages that organization's own identities. Its tokens live in their own
 * table so an organization token can never be presented here, and the other
 * way round.
 *
 * "Delete" turns the account off rather than removing it, and access to orgs
 * and projects still comes from the instance group rules at sign-in.
 */
@Injectable()
export class InstanceScimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly users: UsersService
  ) {}

  baseUrl(): string {
    const configured = process.env.SCIM_BASE_URL;
    const root = configured
      ? configured.replace(/\/+$/, '').replace(/\/scim\/v2$/, '')
      : `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/apiv1`;
    return `${root}/scim/instance/v2`;
  }

  async createToken(actorUserId: string, name: string, expiresAt?: Date) {
    const cleanName = (name ?? '').trim();
    if (!cleanName) throw new BadRequestException('name is required');
    const cap = new Date(Date.now() + MAX_TOKEN_LIFETIME_MS);
    if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    const resolved = expiresAt && expiresAt < cap ? expiresAt : cap;
    const token = `${INSTANCE_SCIM_PREFIX}${randomBytes(32).toString('hex')}`;
    const row = await this.prisma.instanceScimToken.create({
      data: {
        name: cleanName.slice(0, 255),
        tokenHash: hashInstanceScimToken(token),
        createdBy: actorUserId,
        expiresAt: resolved
      }
    });
    void this.audit.log({
      action: 'instance_scim_token.created',
      actorUserId,
      targetType: 'instance_scim_token',
      targetId: row.id,
      targetLabel: row.name
    });
    return {
      id: row.id,
      name: row.name,
      token,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt
    };
  }

  listTokens() {
    return this.prisma.instanceScimToken.findMany({
      select: { id: true, name: true, lastUsedAt: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async revokeToken(actorUserId: string, id: string) {
    const row = await this.prisma.instanceScimToken.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Token not found');
    await this.prisma.instanceScimToken.delete({ where: { id } });
    void this.audit.log({
      action: 'instance_scim_token.revoked',
      actorUserId,
      targetType: 'instance_scim_token',
      targetId: id,
      targetLabel: row.name
    });
    return { success: true };
  }

  async resolveToken(plaintext: string): Promise<boolean> {
    if (!plaintext?.startsWith(INSTANCE_SCIM_PREFIX)) return false;
    const row = await this.prisma.instanceScimToken.findUnique({
      where: { tokenHash: hashInstanceScimToken(plaintext) },
      select: { id: true, expiresAt: true }
    });
    if (!row || (row.expiresAt && row.expiresAt <= new Date())) return false;
    void this.prisma.instanceScimToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return true;
  }

  toScim(user: AccountRow) {
    return {
      schemas: [USER_SCHEMA],
      id: user.id,
      ...(user.scimExternalId ? { externalId: user.scimExternalId } : {}),
      userName: user.email,
      name: {
        ...(user.firstName ? { givenName: user.firstName } : {}),
        ...(user.lastName ? { familyName: user.lastName } : {})
      },
      displayName:
        [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.email,
      emails: [{ value: user.email, primary: true, type: 'work' }],
      active: !user.disabledAt,
      meta: {
        resourceType: 'User',
        created: user.createdAt.toISOString(),
        lastModified: user.updatedAt.toISOString(),
        location: `${this.baseUrl()}/Users/${user.id}`
      }
    };
  }

  private async account(id: string): Promise<AccountRow> {
    const user = await this.prisma.user.findFirst({
      where: { id, emailScope: ACCOUNT_SCOPE },
      select: SELECT
    });
    if (!user) throw instanceScimError(404, `User ${id} not found`);
    return user;
  }

  async list(query: { filter?: string; startIndex?: string; count?: string }) {
    const where: Record<string, unknown> = { emailScope: ACCOUNT_SCOPE };
    if (query.filter) {
      const match = /^\s*(userName|externalId|emails\.value)\s+eq\s+"([^"]*)"\s*$/i.exec(
        query.filter
      );
      if (!match)
        throw instanceScimError(400, 'Only "attr eq \\"value\\"" filters', 'invalidFilter');
      const attr = match[1].toLowerCase();
      if (attr === 'externalid') where.scimExternalId = match[2];
      else where.email = match[2].toLowerCase().trim();
    }
    const startIndex = Math.max(1, Number.parseInt(query.startIndex ?? '1', 10) || 1);
    const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(query.count ?? '100', 10) || 0));
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: SELECT,
        orderBy: { createdAt: 'asc' },
        skip: startIndex - 1,
        take: count
      })
    ]);
    return {
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((r) => this.toScim(r))
    };
  }

  async get(id: string) {
    return this.toScim(await this.account(id));
  }

  private emailOf(body: any): string {
    const primary = Array.isArray(body?.emails)
      ? (body.emails.find((e: any) => e?.primary) ?? body.emails[0])?.value
      : undefined;
    const raw =
      typeof body?.userName === 'string' && body.userName.includes('@') ? body.userName : primary;
    if (typeof raw !== 'string' || !raw.includes('@')) {
      throw instanceScimError(
        400,
        'userName or a primary email must be an email address',
        'invalidValue'
      );
    }
    try {
      return normalizeBoundedEmail(raw);
    } catch {
      throw instanceScimError(400, 'That email address is not valid', 'invalidValue');
    }
  }

  private names(body: any) {
    const trim = (v: unknown) =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null;
    return { firstName: trim(body?.name?.givenName), lastName: trim(body?.name?.familyName) };
  }

  async create(body: any) {
    const email = this.emailOf(body);
    const existing = await this.prisma.user.findUnique({ where: accountEmail(email) });
    if (existing) throw instanceScimError(409, `User ${email} already exists`, 'uniqueness');
    const base = sanitizeUsername(email.split('@')[0]);
    let username = base;
    for (let n = 1; await this.prisma.user.findUnique({ where: { username } }); n += 1) {
      username = `${base}${n}`;
    }
    const created = await this.prisma.user
      .create({
        data: {
          email,
          username,
          ...this.names(body),
          scimExternalId:
            typeof body?.externalId === 'string' ? body.externalId.slice(0, 255) : null,
          ...(body?.active === false
            ? { disabledAt: new Date(), disabledReason: 'Provisioned inactive by SCIM' }
            : {})
        },
        select: SELECT
      })
      .catch((err) => {
        if (err?.code === 'P2002') {
          throw new ConflictException(`User ${email} already exists`);
        }
        throw err;
      });
    void this.audit.log({
      action: 'instance_scim.user.provisioned',
      targetType: 'user',
      targetId: created.id,
      targetLabel: created.email
    });
    return this.toScim(created);
  }

  async replace(id: string, body: any) {
    const user = await this.account(id);
    await this.prisma.user.update({
      where: { id },
      data: {
        ...this.names(body),
        scimExternalId: typeof body?.externalId === 'string' ? body.externalId.slice(0, 255) : null
      }
    });
    if (typeof body?.active === 'boolean') await this.setActive(user, body.active);
    return this.get(id);
  }

  async patch(id: string, body: any) {
    const user = await this.account(id);
    const ops = Array.isArray(body?.Operations) ? body.Operations : null;
    if (!ops) throw instanceScimError(400, 'Operations must be a list', 'invalidSyntax');
    const data: Record<string, unknown> = {};
    let active: boolean | undefined;
    for (const op of ops) {
      const kind = String(op?.op ?? '').toLowerCase();
      if (kind !== 'replace' && kind !== 'add') {
        throw instanceScimError(400, `Unsupported operation "${op?.op}"`, 'invalidSyntax');
      }
      const path = typeof op.path === 'string' ? op.path : null;
      const values: Record<string, unknown> =
        path === null && op.value && typeof op.value === 'object'
          ? op.value
          : { [path ?? '']: op.value };
      for (const [key, value] of Object.entries(values)) {
        if (key === 'active') active = value === true || value === 'True' || value === 'true';
        else if (key === 'name.givenName' || key === 'name') {
          const names = this.names(
            key === 'name' ? { name: value } : { name: { givenName: value } }
          );
          if (key === 'name') Object.assign(data, names);
          else data.firstName = names.firstName;
        } else if (key === 'name.familyName') {
          data.lastName = this.names({ name: { familyName: value } }).lastName;
        } else if (key === 'externalId') {
          data.scimExternalId = typeof value === 'string' ? value.slice(0, 255) : null;
        }
      }
    }
    if (Object.keys(data).length) await this.prisma.user.update({ where: { id }, data });
    if (active !== undefined) await this.setActive(user, active);
    return this.get(id);
  }

  async remove(id: string) {
    const user = await this.account(id);
    await this.setActive(user, false);
  }

  private async setActive(user: AccountRow, active: boolean) {
    if (active === !user.disabledAt) return;
    if (!active) {
      const self = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { isSuperAdmin: true }
      });
      if (self?.isSuperAdmin) {
        const others = await this.prisma.user.count({
          where: { isSuperAdmin: true, disabledAt: null, id: { not: user.id } }
        });
        if (others === 0) throw instanceScimError(400, "The last superadmin can't be turned off");
      }
    }
    await this.users.setDisabled(user.id, !active, active ? undefined : 'Deprovisioned by SCIM');
    void this.audit.log({
      action: active ? 'user.enabled' : 'user.disabled',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { via: 'instance_scim' }
    });
  }

  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { type: 'oauthbearertoken', name: 'Bearer token', description: 'Instance SCIM token' }
      ]
    };
  }
}
