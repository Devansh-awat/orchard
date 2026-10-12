import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export const door = (name: string, version: number): symbol =>
  Symbol.for(`orchard.graft.door.${name}@${version}`);

export const Doors = {
  context: door('context', 1),
  auth: door('auth', 1),
  users: door('users', 1),
  audit: door('audit', 1),
  secrets: door('secrets', 1),
  flags: door('flags', 1),
  settings: door('settings', 1),
  events: door('events', 1),
  db: door('db', 1),
  http: door('http', 1)
} as const;

export type OrgRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'admin' | 'member' | 'viewer';

export interface OrgAccess {
  organizationId: string;
  role: OrgRole;
  isAdmin: boolean;
  source: 'membership' | 'superadmin';
}

export interface ProjectAccess {
  projectId: string;
  organizationId: string;
  source: 'orgAdmin' | 'projectMember' | 'superadmin';
  orgRole: OrgRole | null;
  projectRoleName: ProjectRole | null;
  canView: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
  canDelete: boolean;
}

export interface GraftManifestView {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  permissions: Record<string, { label: string; defaultGrants: string[] }>;
  [key: string]: unknown;
}

export interface ContextDoor {
  readonly id: string;
  readonly version: string;
  readonly manifest: Readonly<GraftManifestView>;
  readonly schema: string;
  readonly role: string;
  readonly apiBase: string;
}

export interface AuthDoor {
  isSuperAdmin(userId: string): Promise<boolean>;
  getOrgAccess(organizationId: string, userId: string): Promise<OrgAccess | null>;
  getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null>;
  requireOrgMember(organizationId: string, userId: string): Promise<OrgAccess>;
  requireOrgAdmin(organizationId: string, userId: string): Promise<OrgAccess>;
  requireOrgOwner(organizationId: string, userId: string): Promise<OrgAccess>;
  requireProjectView(projectId: string, userId: string): Promise<ProjectAccess>;
  requireProjectEdit(projectId: string, userId: string): Promise<ProjectAccess>;
  listVisibleProjectIds(organizationId: string, userId: string): Promise<string[] | null>;
  can(
    userId: string,
    permission: string,
    scope?: { organizationId?: string; projectId?: string }
  ): Promise<boolean>;
  require(
    userId: string,
    permission: string,
    scope?: { organizationId?: string; projectId?: string }
  ): Promise<void>;
}

export interface GraftUser {
  id: string;
  email: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  githubUsername: string | null;
  isSuperAdmin: boolean;
}

export interface UsersDoor {
  get(id: string): Promise<GraftUser | null>;
  getMany(ids: string[]): Promise<GraftUser[]>;
  findByUsername(username: string): Promise<GraftUser | null>;
}

export type AuditMetadataValue = string | number | boolean | null | readonly unknown[];

export interface AuditEntry {
  action: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  deploymentId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, AuditMetadataValue> | null;
}

export interface AuditDoor {
  log(entry: AuditEntry): Promise<void>;
}

export interface SecretsDoor {
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
  isEncrypted(value: string | null | undefined): boolean;
  encryptForUser(userId: string, plaintext: string): string;
  decryptForUser(userId: string, value: string): string;
}

export interface FlagsDoor {
  readonly configured: boolean;
  isEnabled(key: string, distinctId: string): Promise<boolean>;
}

export interface SettingsDoor {
  readonly generation: number;
  all(sectionId: string): Record<string, string | null>;
  value(sectionId: string, key: string): string | null;
  flag(sectionId: string, key: string): boolean;
  isConfigured(sectionId: string): boolean;
}

export interface OrgEvent {
  organizationId: string;
  type: string;
  id?: string;
  projectId?: string;
  payload?: unknown;
  ts: number;
}

export interface Subscribable<T> {
  subscribe(observer: (value: T) => void): { unsubscribe(): void };
}

export interface EventsDoor {
  emitOrg(
    organizationId: string,
    type: string,
    data?: { id?: string; projectId?: string; payload?: unknown }
  ): void;
  stream(): Subscribable<OrgEvent>;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface DbPool {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<{ query: DbPool['query']; release(): void }>;
}

export interface DbDoor {
  readonly schema: string;
  readonly role: string | null;
  pool(): DbPool;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void | Promise<void>;

export interface HostRouter {
  matches(host: string | undefined): boolean;
  handleRequest?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  handleUpgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
}

export interface HttpDoor {
  upgrade(path: string, handler: UpgradeHandler): void;
  hostRouter(router: HostRouter): void;
}
