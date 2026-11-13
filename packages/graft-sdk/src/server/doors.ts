import type { IncomingMessage, Server, ServerResponse } from 'node:http';
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
  http: door('http', 1),
  kube: door('kube', 1),
  apply: door('apply', 1),
  exec: door('exec', 1),
  projects: door('projects', 1),
  notifications: door('notifications', 1),
  rateLimit: door('rateLimit', 1),
  metrics: door('metrics', 1),
  github: door('github', 1),
  storage: door('storage', 1)
} as const;

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
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
  isUnrestrictedSuperAdmin(userId: string): Promise<boolean>;
  getOrgAccess(organizationId: string, userId: string): Promise<OrgAccess | null>;
  getProjectAccess(projectId: string, userId: string): Promise<ProjectAccess | null>;
  requireOrgMember(organizationId: string, userId: string): Promise<OrgAccess>;
  requireOrgAdmin(organizationId: string, userId: string): Promise<OrgAccess>;
  requireOrgOwner(organizationId: string, userId: string): Promise<OrgAccess>;
  requireProjectView(projectId: string, userId: string): Promise<ProjectAccess>;
  requireProjectEdit(projectId: string, userId: string): Promise<ProjectAccess>;
  listVisibleProjectIds(organizationId: string, userId: string): Promise<string[] | null>;
  requireOrgCanCreateProjects(organizationId: string, userId: string): Promise<OrgAccess>;
  validateSession(sessionId: string): Promise<boolean>;
  requestContext(): RequestAuthContext | undefined;
  runWithContext<T>(ctx: RequestAuthContext, fn: () => T): T;
  authenticateUpgrade(req: IncomingMessage, requiredScope: string): Promise<UpgradeIdentity | null>;
  authenticateTerminalUpgrade(req: IncomingMessage): Promise<TerminalAuth | Rejection>;
  originAllowed(origin: string | undefined, via: 'cookie' | 'bearer'): boolean;
  rejectUpgrade(socket: Duplex, status: number, message: string): void;
  registerOrgScopedDevice(prefix: string, denyPaths?: string[]): void;
  deviceName(prefix: string, organizationId: string | null | undefined, subject: string): string;
  revokeDeviceSessions(userId: string, deviceNames: string[]): Promise<number>;
  mintDeviceToken(input: {
    userId: string;
    deviceName: string;
    ttlDays: number;
    reuseIfValidForDays?: number;
  }): Promise<string | null>;
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

export interface RequestAuthContext {
  apiTokenId?: string;
  tokenScopes?: string[];
  tokenProjectIds?: string[];
  sessionOrgId?: string;
  browserSession?: boolean;
  mcpGateway?: boolean;
}

export interface UpgradeIdentity {
  userId: string;
  email: string | null;
  sessionId: string | null;
  orgScope: string | null;
  via: 'cookie' | 'bearer' | 'api-token';
}

export interface TokenAuthContext {
  apiTokenId: string;
  tokenScopes: string[];
  tokenProjectIds: string[];
}

export interface TerminalAuth {
  userId: string;
  actorEmail: string | null;
  browserSessionId: string | undefined;
  sessionOrgScope: string | undefined;
  tokenAuthCtx: TokenAuthContext | null;
  isProxyHop: boolean;
}

export type Rejection = { reject: number; message: string };

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
  resolve(
    identifier: string,
    profile?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ): Promise<GraftUser & Record<string, unknown>>;
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
  readonly enabled: boolean;
  seal<T extends string | null | undefined>(value: T): T;
  open<T extends string | null | undefined>(value: T): T;
  maybeDecrypt<T extends { value: string }>(row: T): T;
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
  validate(sectionId: string, check: (values: Record<string, string | null>) => void): void;
  stored(key: string): Promise<string | null>;
  storeIfAbsent(key: string, value: string): Promise<boolean>;
  store(key: string, value: string): Promise<void>;
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
  onListen(handler: (server: Server) => void | Promise<void>): void;
  hostRouter(router: HostRouter): void;
}

export interface KubeConfigLike {
  makeApiClient<T>(apiClientType: new (server: string) => T): T;
  getCurrentCluster(): { server: string } | null;
  [key: string]: unknown;
}

export interface EngineListPage {
  items: unknown[];
  resourceVersion: string;
  continueToken: string | null;
}

export interface EngineResource {
  kind: string;
  apiVersion: string;
  watchPath: string;
  labelSelector?: string;
  fieldSelector?: string;
  list(kc: never, opts: { continueToken?: string; limit?: number }): Promise<EngineListPage>;
  sanitize?(obj: unknown): unknown;
  onEvent?(type: string, obj: unknown): unknown;
  onListComplete?(seen: unknown): unknown;
}

export interface EngineShard {
  name: string;
  lease: string;
  resources: EngineResource[];
}

export type MirrorListPage = EngineListPage;
export type MirrorResource = EngineResource;
export type MirrorShard = EngineShard;

export interface KubeDoor {
  readonly kc: KubeConfigLike | null;
  isLeader(): boolean;
  onLeaderAcquired(listener: () => void): void;
  registerEngineShard(build: () => Promise<EngineShard | null>): void;
  registerMirrorShard(build: () => Promise<EngineShard | null>): void;
  databaseTlsHostname(namespace: string, clusterName: string): string | null;
}

export interface ApplyItem {
  dedupeKey: string;
  opType: string;
  manifest: unknown;
  deploymentId: string | null;
  subjectId?: string | null;
}

export interface ApplyDoor {
  registerHandler(opType: string, handler: (item: ApplyItem) => Promise<void>): void;
  enqueue(input: {
    dedupeKey: string;
    opType: string;
    manifest?: unknown;
    deploymentId?: string;
    subjectId?: string;
    requestedById?: string;
  }): Promise<void>;
  hasOpenItem(dedupeKey: string): Promise<boolean>;
  retryForSubject(subjectId: string): Promise<number>;
  serverSideApply<T extends { apiVersion?: string; kind?: string }>(manifest: T): Promise<T>;
}

export interface ExecDoor {
  register(hooks: Record<string, unknown> & { route: RegExp }): void;
}

export interface ProjectsDoor {
  onEnvironmentEnvChanged(
    listener: (change: { environmentId: string; [key: string]: unknown }) => void
  ): () => void;
  createDeploymentFromGitHub(
    projectId: string,
    data: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<any>;
  rebuildDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: Record<string, unknown>
  ): Promise<any>;
  createAutoIngressForDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: Record<string, unknown>
  ): Promise<any>;
  setDeploymentBranch(deploymentId: string, branch: string): Promise<void>;
  createEnvironment(
    projectId: string,
    input: { name: string; slug?: string },
    userId: string
  ): Promise<any>;
  deleteEnvironment(
    environmentId: string,
    actor: { userId: string; email?: string },
    confirmName: unknown
  ): Promise<any>;
  deleteEnvironmentFromCluster(
    environmentId: string,
    cause: { reason: string; source: string; namespace: string }
  ): Promise<any>;
}

export type NotificationSettingValue = 'off' | 'inbox' | 'email' | string;

export interface NotificationsDoor {
  registerEvent(def: {
    event: `${string}.${string}`;
    category: string;
    categoryLabel?: string;
    categoryDefault?: NotificationSettingValue;
    categoryOptions?: NotificationSettingValue[];
    categoryCopy?: Record<string, { label: string; hint: string }>;
    scope: string;
    tone: 'success' | 'failure' | 'notice';
  }): void;
  notifyAccount(
    userId: string,
    message: {
      event: string;
      title: string;
      body: string;
      url?: string;
      projectId?: string;
      projectName?: string;
      targetId?: string;
      targetName?: string;
      fields?: { name: string; value: string }[];
    },
    dedupeKey: string
  ): Promise<unknown>;
}

export type RateLimitIdentifier = 'email' | 'ip' | 'ingress' | 'org' | 'user';

export interface RateLimitDoor {
  define(
    action: string,
    type: RateLimitIdentifier,
    config: { maxAttempts: number; windowMs: number; blockDurationMs: number }
  ): void;
  check(identifier: string, type: RateLimitIdentifier, action: string): Promise<void>;
  consume(
    key: string,
    window: { maxAttempts: number; windowMs: number; blockDurationMs: number }
  ): Promise<number | null>;
}

export interface MetricsDoor {
  readonly configured: boolean;
  queryInstant(promql: string): Promise<number | null>;
  escapeLabel(value: string): string;
}

export interface GitHubDoor {
  userToken(userId: string): Promise<string | null>;
  repoToken(userId: string, owner: string, repo: string): Promise<string | null>;
  installationToken(installationId: bigint): Promise<string>;
  onIssueComment(
    handler:
      | ((deliveryId: string | undefined, body: unknown) => Promise<Record<string, unknown>>)
      | null
  ): void;
}

export interface StorageDoor {
  readonly configured: boolean;
  readonly publicBase: string | null;
  owns(url: string): boolean;
  upload(file: { data: Uint8Array; contentType: string; extension: string }): Promise<string>;
  delete(url: string): Promise<void>;
}
