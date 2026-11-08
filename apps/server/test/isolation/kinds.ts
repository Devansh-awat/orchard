export type KindLevel = 'project' | 'org' | 'user' | 'literal';

export const PROJECT_KINDS = [
  'project',
  'projectSlug',
  'namespace',
  'environment',
  'deployment',
  'service',
  'servicePort',
  'ingress',
  'database',
  'databaseCheckpoint',
  'checkpointGroup',
  'databaseOperation',
  'deletedDatabase',
  'composeStack',
  'job',
  'jobRun',
  'registryCredential',
  'webhookToken',
  'binding',
  'release',
  'imageHistory',
  'buildRun',
  'templateInstance',
  'projectMember',
  'projectInvitation',
  'errorFingerprint',
  'projectTransfer',
  'databaseBackup'
] as const;

export const ORG_KINDS = [
  'org',
  'orgSlug',
  'orgMember',
  'user',
  'orgInvitation',
  'orgDomain',
  'notificationChannel',
  'notificationRule',
  'metricAlertRule',
  'statusPage',
  'orgRegistryCredential',
  'ssoProvider',
  'scimToken',
  'scopeId'
] as const;

export const USER_KINDS = [
  'session',
  'apiToken',
  'passkey',
  'gitConnection',
  'notificationDestination',
  'invitationToken',
  'accountLink'
] as const;

export const LITERAL_KINDS = [
  'githubOwner',
  'githubRepo',
  'provider',
  'name',
  'stepOrder',
  'scopeType',
  'subdomain',
  'slug',
  'template',
  'publicToken',
  'pod',
  'killedContainer'
] as const;

export const UNSEEDED_KINDS: readonly string[] = ['sshIdentity'];

const LEVELS: Record<string, KindLevel> = {};
for (const kind of PROJECT_KINDS) LEVELS[kind] = 'project';
for (const kind of ORG_KINDS) LEVELS[kind] = 'org';
for (const kind of USER_KINDS) LEVELS[kind] = 'user';
for (const kind of LITERAL_KINDS) LEVELS[kind] = 'literal';

export function kindLevel(kind: string): KindLevel | null {
  return LEVELS[kind] ?? null;
}

export function isTenantKind(kind: string): boolean {
  const level = kindLevel(kind);
  return level === 'project' || level === 'org' || level === 'user';
}

export function isSeededKind(kind: string): boolean {
  return isTenantKind(kind) && !UNSEEDED_KINDS.includes(kind);
}

export const FIELD_KIND: Record<string, string> = {
  organizationId: 'org',
  orgId: 'org',
  destinationOrgId: 'org',
  projectId: 'project',
  restrictedProjectIds: 'project',
  targetProjectId: 'project',
  deploymentId: 'deployment',
  sourceDeploymentId: 'deployment',
  databaseId: 'database',
  databaseIds: 'database',
  environmentId: 'environment',
  ingressId: 'ingress',
  serviceId: 'service',
  channelId: 'notificationChannel',
  scopeId: 'scopeId',
  backupId: 'databaseBackup',
  checkpointId: 'databaseCheckpoint',
  resourceId: 'database',
  gitConnectionId: 'gitConnection',
  namespace: 'namespace',
  templateId: 'template',
  userId: 'user',
  nodePoolId: 'nodePool',
  assigneeId: 'user'
};
