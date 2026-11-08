import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

export type Ids = Record<string, string>;

export type UserKey =
  | 'o1Owner'
  | 'o1Admin'
  | 'o1Member'
  | 'o1Viewer'
  | 'o1P2Member'
  | 'o1Plain'
  | 'o1Guest'
  | 'o2Owner'
  | 'dual'
  | 'invitee';

export type ProjectKey = 'p1' | 'p2' | 'p3' | 'p4';
export type OrgKey = 'o1' | 'o2';

export interface UserCtx {
  key: UserKey;
  id: string;
  email: string;
  sessionId: string;
  jwt: string;
  ids: Ids;
  markers: string[];
}

export interface ProjectCtx {
  key: ProjectKey;
  orgKey: OrgKey;
  id: string;
  name: string;
  slug: string;
  namespace: string;
  ids: Ids;
  markers: string[];
}

export interface OrgCtx {
  key: OrgKey;
  id: string;
  name: string;
  slug: string;
  ids: Ids;
  markers: string[];
  projects: ProjectCtx[];
}

export interface World {
  tag: string;
  secret: Uint8Array;
  orgs: Record<OrgKey, OrgCtx>;
  projects: Record<ProjectKey, ProjectCtx>;
  users: Record<UserKey, UserCtx>;
  templateId: string;
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function newApiToken(): { plaintext: string; hash: string } {
  const plaintext = `orch_${randomBytes(24).toString('hex')}`;
  return { plaintext, hash: hashToken(plaintext) };
}

export async function mintJwt(
  secret: Uint8Array,
  userId: string,
  sessionId: string,
  orgScope?: string
): Promise<string> {
  return new SignJWT({ sub: userId, sessionId, ...(orgScope ? { orgScope } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(secret);
}

const USER_KEYS: UserKey[] = [
  'o1Owner',
  'o1Admin',
  'o1Member',
  'o1Viewer',
  'o1P2Member',
  'o1Plain',
  'o1Guest',
  'o2Owner',
  'dual',
  'invitee'
];

const ORG_PROJECTS: Record<OrgKey, ProjectKey[]> = { o1: ['p1', 'p2'], o2: ['p3', 'p4'] };

export function tagOf(): string {
  return `iso${randomBytes(4).toString('hex')}`;
}

export async function seedWorld(
  prisma: PrismaClient,
  secret: Uint8Array,
  tag: string
): Promise<World> {
  const [adminRole, memberRole, viewerRole] = await Promise.all(
    ['admin', 'member', 'viewer'].map((name) =>
      prisma.role.upsert({ where: { name }, update: {}, create: { name } })
    )
  );

  const users = {} as Record<UserKey, UserCtx>;
  const userRows: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
  }[] = [];
  const sessionRows: {
    id: string;
    userId: string;
    expiresAt: Date;
    ipAddress: string;
    userAgent: string;
  }[] = [];
  for (const key of USER_KEYS) {
    const id = randomUUID();
    const email = `${tag}-${key.toLowerCase()}@isolation.test`;
    const sessionId = randomUUID();
    userRows.push({ id, email, username: `${tag}-${key}`, firstName: key, lastName: tag });
    sessionRows.push({
      id: sessionId,
      userId: id,
      expiresAt: new Date(Date.now() + 2 * 3600_000),
      ipAddress: '127.0.0.1',
      userAgent: tag
    });
    users[key] = {
      key,
      id,
      email,
      sessionId,
      jwt: await mintJwt(secret, id, sessionId),
      ids: { session: sessionId },
      markers: [sessionId]
    };
  }
  await prisma.user.createMany({ data: userRows });
  await prisma.session.createMany({ data: sessionRows });

  const orgRows: { id: string; name: string; slug: string; createdBy: string }[] = [];
  const orgs = {} as Record<OrgKey, OrgCtx>;
  const orgOwner: Record<OrgKey, UserKey> = { o1: 'o1Owner', o2: 'o2Owner' };
  for (const key of ['o1', 'o2'] as OrgKey[]) {
    const id = randomUUID();
    const name = `${tag} Org ${key}`;
    const slug = `${tag}-org-${key}`;
    orgRows.push({ id, name, slug, createdBy: users[orgOwner[key]].id });
    orgs[key] = { key, id, name, slug, ids: { org: id }, markers: [id, name, slug], projects: [] };
  }
  await prisma.organization.createMany({ data: orgRows });

  const members: {
    id: string;
    organizationId: string;
    userId: string;
    role: 'owner' | 'admin' | 'member' | 'guest';
  }[] = [];
  const addMember = (org: OrgKey, user: UserKey, role: 'owner' | 'admin' | 'member' | 'guest') => {
    members.push({ id: randomUUID(), organizationId: orgs[org].id, userId: users[user].id, role });
  };
  addMember('o1', 'o1Owner', 'owner');
  addMember('o1', 'o1Admin', 'admin');
  addMember('o1', 'o1Member', 'member');
  addMember('o1', 'o1Viewer', 'member');
  addMember('o1', 'o1P2Member', 'member');
  addMember('o1', 'o1Plain', 'member');
  addMember('o1', 'o1Guest', 'guest');
  addMember('o1', 'dual', 'owner');
  addMember('o2', 'o2Owner', 'owner');
  addMember('o2', 'dual', 'owner');
  await prisma.organizationMember.createMany({ data: members });
  for (const member of members) {
    const org = orgs[member.organizationId === orgs.o1.id ? 'o1' : 'o2'];
    if (member.userId === users.o1Plain.id && org.key === 'o1') org.ids.orgMember = member.id;
    if (member.userId === users.o2Owner.id && org.key === 'o2') org.ids.orgMember = member.id;
    if (member.userId === users.o1Plain.id && org.key === 'o1') org.ids.user = member.userId;
    if (member.userId === users.o2Owner.id && org.key === 'o2') org.ids.user = member.userId;
    org.markers.push(member.id);
  }
  orgs.o1.markers.push(
    users.o1Owner.email,
    users.o1Admin.email,
    users.o1Member.email,
    users.o1Viewer.email,
    users.o1P2Member.email,
    users.o1Plain.email,
    users.o1Guest.email
  );
  orgs.o2.markers.push(users.o2Owner.email);

  const templateId = randomUUID();
  await prisma.template.create({
    data: {
      id: templateId,
      name: `${tag}-template`,
      displayName: `${tag} template`,
      yaml: 'name: iso\n',
      source: 'custom'
    }
  });

  const projects = {} as Record<ProjectKey, ProjectCtx>;
  const projectRows: {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    namespace: string;
    createdBy: string;
  }[] = [];
  for (const orgKey of ['o1', 'o2'] as OrgKey[]) {
    for (const key of ORG_PROJECTS[orgKey]) {
      const id = randomUUID();
      const name = `${tag} Project ${key}`;
      const slug = `${tag}-${key}`;
      const namespace = `${tag}-${key}-ns`;
      projectRows.push({
        id,
        organizationId: orgs[orgKey].id,
        name,
        slug,
        namespace,
        createdBy: users[orgOwner[orgKey]].id
      });
      const ctx: ProjectCtx = {
        key,
        orgKey,
        id,
        name,
        slug,
        namespace,
        ids: { project: id },
        markers: [id, name, slug, namespace]
      };
      projects[key] = ctx;
      orgs[orgKey].projects.push(ctx);
    }
  }
  await prisma.project.createMany({ data: projectRows });

  await prisma.projectMember.createMany({
    data: [
      { projectId: projects.p1.id, userId: users.o1Member.id, roleId: memberRole.id },
      { projectId: projects.p1.id, userId: users.o1Viewer.id, roleId: viewerRole.id },
      { projectId: projects.p2.id, userId: users.o1P2Member.id, roleId: memberRole.id },
      { projectId: projects.p1.id, userId: users.o1Admin.id, roleId: adminRole.id },
      { projectId: projects.p3.id, userId: users.o2Owner.id, roleId: adminRole.id }
    ]
  });
  const projectMemberRows = await prisma.projectMember.findMany({
    where: { projectId: { in: Object.values(projects).map((p) => p.id) } },
    select: { id: true, projectId: true, userId: true }
  });
  for (const row of projectMemberRows) {
    const project = Object.values(projects).find((p) => p.id === row.projectId);
    if (project && !project.ids.projectMember) {
      project.ids.projectMember = row.id;
      project.markers.push(row.id);
    }
  }

  await seedProjectResources(prisma, tag, projects, orgs, users, templateId);
  await seedOrgResources(prisma, tag, orgs, projects, users);
  await seedUserResources(prisma, tag, users, orgs);
  return { tag, secret, orgs, projects, users, templateId };
}

function pushIds(ctx: { ids: Ids; markers: string[] }, ids: Ids, extra: string[] = []) {
  Object.assign(ctx.ids, ids);
  for (const value of Object.values(ids)) ctx.markers.push(value);
  ctx.markers.push(...extra);
}

async function seedProjectResources(
  prisma: PrismaClient,
  tag: string,
  projects: Record<ProjectKey, ProjectCtx>,
  orgs: Record<OrgKey, OrgCtx>,
  users: Record<UserKey, UserCtx>,
  templateId: string
) {
  const all = Object.values(projects);
  const rows = {
    environment: [] as any[],
    deployment: [] as any[],
    envVar: [] as any[],
    service: [] as any[],
    port: [] as any[],
    ingress: [] as any[],
    webhook: [] as any[],
    release: [] as any[],
    imageHistory: [] as any[],
    buildRun: [] as any[],
    database: [] as any[],
    binding: [] as any[],
    backup: [] as any[],
    checkpoint: [] as any[],
    operation: [] as any[],
    deleted: [] as any[],
    compose: [] as any[],
    job: [] as any[],
    jobRun: [] as any[],
    registry: [] as any[],
    instance: [] as any[],
    invitation: [] as any[],
    errorGroup: [] as any[]
  };
  for (const project of all) {
    const k = project.key;
    const org = orgs[project.orgKey];
    const ids: Ids = {
      environment: randomUUID(),
      deployment: randomUUID(),
      service: randomUUID(),
      servicePort: randomUUID(),
      ingress: randomUUID(),
      webhookToken: randomUUID(),
      release: randomUUID(),
      imageHistory: randomUUID(),
      buildRun: randomUUID(),
      database: randomUUID(),
      binding: randomUUID(),
      databaseBackup: randomUUID(),
      databaseCheckpoint: randomUUID(),
      checkpointGroup: randomUUID(),
      databaseOperation: randomUUID(),
      deletedDatabase: randomUUID(),
      composeStack: randomUUID(),
      job: randomUUID(),
      jobRun: randomUUID(),
      registryCredential: randomUUID(),
      templateInstance: randomUUID(),
      projectInvitation: randomUUID()
    };
    const depName = `${tag}-dep-${k}`;
    const dbName = `${tag}-db-${k}`;
    const envVal = `canary-env-${tag}-${k}`;
    const secretVal = `canary-secret-${tag}-${k}`;
    const host = `${tag}-${k}.victim.invalid`;
    const dbPassword = `canary-dbpass-${tag}-${k}`;
    const registryPassword = `canary-registry-${tag}-${k}`;
    const fingerprint = `fp-${tag}-${k}`;

    rows.environment.push({
      id: ids.environment,
      projectId: project.id,
      name: 'production',
      slug: 'production',
      namespace: project.namespace,
      isDefault: true
    });
    rows.deployment.push({
      id: ids.deployment,
      projectId: project.id,
      environmentId: ids.environment,
      name: depName,
      namespace: project.namespace,
      image: 'nginx:1.27',
      status: 'running'
    });
    rows.envVar.push(
      { deploymentId: ids.deployment, key: 'CANARY_PLAIN', value: envVal, secret: false },
      { deploymentId: ids.deployment, key: 'CANARY_SECRET', value: secretVal, secret: true }
    );
    rows.service.push({
      id: ids.service,
      deploymentId: ids.deployment,
      name: `${tag}-svc-${k}`,
      type: 'internal',
      port: 80,
      targetPort: 80
    });
    rows.port.push({ id: ids.servicePort, serviceId: ids.service, port: 80, targetPort: 80 });
    rows.ingress.push({
      id: ids.ingress,
      projectId: project.id,
      deploymentId: ids.deployment,
      serviceId: ids.service,
      environmentId: ids.environment,
      name: `${tag}-ing-${k}`,
      namespace: project.namespace,
      host
    });
    rows.webhook.push({
      id: ids.webhookToken,
      deploymentId: ids.deployment,
      tokenHash: hashToken(`wh-${tag}-${k}`),
      label: `canary-webhook-${tag}-${k}`
    });
    rows.release.push({
      id: ids.release,
      deploymentId: ids.deployment,
      image: 'nginx:1.27',
      envSnapshot: [],
      resourceSnapshot: {}
    });
    rows.imageHistory.push({
      id: ids.imageHistory,
      deploymentId: ids.deployment,
      image: 'nginx:1.27',
      tag: `canary-tag-${tag}-${k}`
    });
    rows.buildRun.push({ id: ids.buildRun, deploymentId: ids.deployment, triggerType: 'manual' });
    rows.database.push({
      id: ids.database,
      projectId: project.id,
      environmentId: ids.environment,
      name: dbName,
      dbName: `d${k}${tag}`.slice(0, 60),
      dbUser: `u${k}${tag}`.slice(0, 60),
      dbPassword,
      namespace: project.namespace
    });
    rows.binding.push({
      id: ids.binding,
      deploymentId: ids.deployment,
      resourceType: 'database',
      resourceId: ids.database,
      name: 'DB'
    });
    rows.backup.push({
      id: ids.databaseBackup,
      databaseId: ids.database,
      label: `canary-backup-${tag}-${k}`,
      backupName: `bk-${tag}-${k}`
    });
    rows.checkpoint.push({
      id: ids.databaseCheckpoint,
      databaseId: ids.database,
      groupId: ids.checkpointGroup,
      label: `canary-checkpoint-${tag}-${k}`,
      kind: 'manual',
      restorePointName: `rp-${tag}-${k}`
    });
    rows.operation.push({
      id: ids.databaseOperation,
      databaseId: ids.database,
      kind: 'restore',
      target: {},
      source: {}
    });
    rows.deleted.push({
      id: ids.deletedDatabase,
      projectId: project.id,
      organizationId: org.id,
      name: `canary-deleted-${tag}-${k}`,
      namespace: project.namespace,
      clusterName: `cluster-${tag}-${k}`,
      backupServerName: `server-${tag}-${k}`,
      destinationPath: `s3://canary/${tag}/${k}`,
      pgMajor: 16,
      snapshot: {},
      reason: 'deleted',
      purgeAfter: new Date(Date.now() + 7 * 86400_000)
    });
    rows.compose.push({
      id: ids.composeStack,
      projectId: project.id,
      environmentId: ids.environment,
      name: `${tag}-stack-${k}`,
      composeYaml: 'services: {}\n'
    });
    rows.job.push({
      id: ids.job,
      projectId: project.id,
      environmentId: ids.environment,
      name: `${tag}-job-${k}`
    });
    rows.jobRun.push({
      id: ids.jobRun,
      jobId: ids.job,
      number: 1,
      trigger: 'manual',
      stepsSnapshot: []
    });
    rows.registry.push({
      id: ids.registryCredential,
      projectId: project.id,
      registry: `registry-${tag}-${k}.victim.invalid`,
      username: `canary-user-${tag}-${k}`,
      password: registryPassword
    });
    rows.instance.push({
      id: ids.templateInstance,
      templateId,
      projectId: project.id,
      name: `${tag}-instance-${k}`,
      parameters: {}
    });
    rows.errorGroup.push({
      deploymentId: ids.deployment,
      fingerprint,
      type: 'Error',
      message: `canary-error-${tag}-${k}`,
      firstSeenAt: new Date(),
      lastSeenAt: new Date()
    });
    pushIds(project, { ...ids, errorFingerprint: fingerprint, projectSlug: project.slug }, [
      depName,
      dbName,
      envVal,
      secretVal,
      host,
      dbPassword,
      registryPassword,
      `${tag}-svc-${k}`,
      `${tag}-ing-${k}`,
      `${tag}-stack-${k}`,
      `${tag}-job-${k}`,
      `${tag}-instance-${k}`,
      `canary-webhook-${tag}-${k}`,
      `canary-tag-${tag}-${k}`,
      `canary-backup-${tag}-${k}`,
      `canary-checkpoint-${tag}-${k}`,
      `canary-deleted-${tag}-${k}`,
      `canary-error-${tag}-${k}`,
      `canary-user-${tag}-${k}`
    ]);
    project.ids.namespace = project.namespace;
    void users;
  }

  await prisma.environment.createMany({ data: rows.environment });
  await prisma.deployment.createMany({ data: rows.deployment });
  await prisma.deploymentEnvVar.createMany({ data: rows.envVar });
  await prisma.service.createMany({ data: rows.service });
  await prisma.servicePort.createMany({ data: rows.port });
  await prisma.ingress.createMany({ data: rows.ingress });
  await prisma.deploymentWebhookToken.createMany({ data: rows.webhook });
  await prisma.release.createMany({ data: rows.release });
  await prisma.imageHistory.createMany({ data: rows.imageHistory });
  await prisma.buildRun.createMany({ data: rows.buildRun });
  await prisma.database.createMany({ data: rows.database });
  await prisma.resourceBinding.createMany({ data: rows.binding });
  await prisma.databaseBackup.createMany({ data: rows.backup });
  await prisma.databaseCheckpoint.createMany({ data: rows.checkpoint });
  await prisma.databaseOperation.createMany({ data: rows.operation });
  await prisma.deletedDatabase.createMany({ data: rows.deleted });
  await prisma.composeStack.createMany({ data: rows.compose });
  await prisma.job.createMany({ data: rows.job });
  await prisma.jobRun.createMany({ data: rows.jobRun });
  await prisma.registryCredential.createMany({ data: rows.registry });
  await prisma.templateInstance.createMany({ data: rows.instance });
  await prisma.errorGroup.createMany({ data: rows.errorGroup });

  const memberRole = await prisma.role.findUniqueOrThrow({ where: { name: 'member' } });
  const inviteRows = all.map((project) => ({
    id: project.ids.projectInvitation,
    projectId: project.id,
    userId: users.invitee.id,
    roleId: memberRole.id,
    invitedBy: users[project.orgKey === 'o1' ? 'o1Owner' : 'o2Owner'].id
  }));
  await prisma.projectInvitation.createMany({ data: inviteRows }).catch(() => undefined);
  for (const project of all) {
    const transferId = randomUUID();
    const from = users[project.orgKey === 'o1' ? 'o1Owner' : 'o2Owner'];
    const to = users.invitee;
    await prisma.projectTransferRequest
      .create({
        data: {
          id: transferId,
          projectId: project.id,
          fromUserId: from.id,
          toUserId: to.id,
          expiresAt: new Date(Date.now() + 86400_000)
        }
      })
      .then(() => pushIds(project, { projectTransfer: transferId }))
      .catch(() => undefined);
  }
}

async function seedOrgResources(
  prisma: PrismaClient,
  tag: string,
  orgs: Record<OrgKey, OrgCtx>,
  projects: Record<ProjectKey, ProjectCtx>,
  users: Record<UserKey, UserCtx>
) {
  void projects;
  const rows = {
    invitation: [] as any[],
    domain: [] as any[],
    channel: [] as any[],
    rule: [] as any[],
    alert: [] as any[],
    status: [] as any[],
    registry: [] as any[],
    provider: [] as any[],
    scim: [] as any[]
  };
  for (const org of Object.values(orgs)) {
    const k = org.key;
    const owner = users[k === 'o1' ? 'o1Owner' : 'o2Owner'];
    const ids: Ids = {
      orgInvitation: randomUUID(),
      orgDomain: randomUUID(),
      notificationChannel: randomUUID(),
      notificationRule: randomUUID(),
      metricAlertRule: randomUUID(),
      statusPage: randomUUID(),
      orgRegistryCredential: randomUUID(),
      ssoProvider: randomUUID(),
      scimToken: randomUUID()
    };
    const inviteEmail = `${tag}-invitee-${k}@isolation.test`;
    const inviteToken = `invite-${tag}-${k}-${randomBytes(6).toString('hex')}`;
    const domain = `${tag}-${k}.victim.invalid`;
    const channelName = `canary-channel-${tag}-${k}`;
    const statusSlug = `${tag}-status-${k}`;
    const providerSlug = `${tag}-idp-${k}`;
    const orgRegistry = `org-registry-${tag}-${k}.victim.invalid`;
    rows.invitation.push({
      id: ids.orgInvitation,
      organizationId: org.id,
      email: inviteEmail,
      token: inviteToken,
      tokenHash: hashToken(inviteToken),
      invitedBy: owner.id,
      expiresAt: new Date(Date.now() + 86400_000)
    });
    rows.domain.push({
      id: ids.orgDomain,
      organizationId: org.id,
      domain,
      verificationToken: `vt-${tag}-${k}`
    });
    rows.channel.push({
      id: ids.notificationChannel,
      organizationId: org.id,
      name: channelName,
      type: 'webhook',
      config: { url: `https://hooks.victim.invalid/${tag}/${k}` }
    });
    rows.rule.push({
      id: ids.notificationRule,
      organizationId: org.id,
      channelId: ids.notificationChannel,
      scopeType: 'org'
    });
    rows.alert.push({
      id: ids.metricAlertRule,
      organizationId: org.id,
      scopeType: 'org',
      metric: 'cpu',
      comparator: 'gt',
      threshold: 0.9
    });
    rows.status.push({
      id: ids.statusPage,
      organizationId: org.id,
      slug: statusSlug,
      title: `canary-status-${tag}-${k}`
    });
    rows.registry.push({
      id: ids.orgRegistryCredential,
      organizationId: org.id,
      registry: orgRegistry,
      username: `canary-orguser-${tag}-${k}`,
      password: `canary-orgregistry-${tag}-${k}`
    });
    rows.provider.push({
      id: ids.ssoProvider,
      organizationId: org.id,
      slug: providerSlug,
      name: `canary-idp-${tag}-${k}`,
      protocol: 'oidc',
      clientId: `canary-client-${tag}-${k}`,
      clientSecret: `canary-clientsecret-${tag}-${k}`
    });
    rows.scim.push({
      id: ids.scimToken,
      organizationId: org.id,
      name: `canary-scim-${tag}-${k}`,
      tokenHash: hashToken(`scim-${tag}-${k}`)
    });
    org.ids.orgSlug = org.slug;
    org.ids.scopeId = org.id;
    org.ids.invitationToken = inviteToken;
    org.ids.statusSlug = statusSlug;
    pushIds(org, ids, [
      inviteEmail,
      inviteToken,
      domain,
      channelName,
      statusSlug,
      `canary-status-${tag}-${k}`,
      providerSlug,
      `canary-idp-${tag}-${k}`,
      `canary-clientsecret-${tag}-${k}`,
      orgRegistry,
      `canary-orguser-${tag}-${k}`,
      `canary-orgregistry-${tag}-${k}`,
      `canary-scim-${tag}-${k}`
    ]);
  }
  await prisma.organizationInvitation.createMany({ data: rows.invitation });
  await prisma.orgDomain.createMany({ data: rows.domain });
  await prisma.notificationChannel.createMany({ data: rows.channel });
  await prisma.notificationRule.createMany({ data: rows.rule });
  await prisma.metricAlertRule.createMany({ data: rows.alert });
  await prisma.statusPage.createMany({ data: rows.status });
  await prisma.organizationRegistryCredential.createMany({ data: rows.registry });
  await prisma.identityProvider.createMany({ data: rows.provider });
  await prisma.scimToken.createMany({ data: rows.scim });
}

async function seedUserResources(
  prisma: PrismaClient,
  tag: string,
  users: Record<UserKey, UserCtx>,
  orgs: Record<OrgKey, OrgCtx>
) {
  const identities: any[] = [];
  const links: any[] = [];
  const tokens: any[] = [];
  const passkeys: any[] = [];
  const connections: any[] = [];
  const destinations: any[] = [];
  for (const user of Object.values(users)) {
    const ids: Ids = {
      apiToken: randomUUID(),
      passkey: randomUUID(),
      gitConnection: randomUUID(),
      notificationDestination: randomUUID(),
      accountLink: randomUUID()
    };
    const identityId = randomUUID();
    const homeOrg = orgs[user.key.slice(0, 2) as OrgKey] ?? orgs.o1;
    identities.push({
      id: identityId,
      email: `canary-identity-${tag}-${user.key}@victim.invalid`,
      emailScope: homeOrg.id,
      homeOrganizationId: homeOrg.id,
      username: `canary-identity-${tag}-${user.key}`
    });
    links.push({
      id: ids.accountLink,
      identityUserId: identityId,
      accountUserId: user.id,
      organizationId: homeOrg.id
    });
    const credential = `cred-${tag}-${user.key}`;
    const tokenPlain = `orch_${tag}${user.key}${randomBytes(8).toString('hex')}`;
    tokens.push({
      id: ids.apiToken,
      name: `canary-token-${tag}-${user.key}`,
      tokenHash: hashToken(tokenPlain),
      scopes: ['read'],
      userId: user.id
    });
    passkeys.push({
      id: ids.passkey,
      userId: user.id,
      credentialId: credential,
      publicKey: `canary-pk-${tag}-${user.key}`,
      deviceType: 'singleDevice'
    });
    connections.push({
      id: ids.gitConnection,
      userId: user.id,
      provider: 'github',
      name: `canary-git-${tag}-${user.key}`,
      baseUrl: 'https://git.victim.invalid',
      token: `canary-gittoken-${tag}-${user.key}`,
      webhookSecret: `canary-gitsecret-${tag}-${user.key}`
    });
    destinations.push({
      id: ids.notificationDestination,
      userId: user.id,
      type: 'webhook',
      config: { url: `https://dest.victim.invalid/${tag}/${user.key}` }
    });
    Object.assign(user.ids, ids);
    user.markers.push(
      ...Object.values(ids),
      tokenPlain,
      credential,
      `canary-token-${tag}-${user.key}`,
      `canary-git-${tag}-${user.key}`,
      `canary-gittoken-${tag}-${user.key}`,
      `canary-gitsecret-${tag}-${user.key}`,
      `https://dest.victim.invalid/${tag}/${user.key}`
    );
  }
  await prisma.apiToken.createMany({ data: tokens });
  await prisma.passkey.createMany({ data: passkeys });
  await prisma.gitConnection.createMany({ data: connections });
  await prisma.userNotificationDestination.createMany({ data: destinations });
  await prisma.user.createMany({ data: identities });
  await prisma.accountLink.createMany({ data: links });
}

export async function teardownWorld(prisma: PrismaClient, world: World): Promise<void> {
  const orgIds = Object.values(world.orgs).map((org) => org.id);
  const userIds = Object.values(world.users).map((user) => user.id);
  const projectIds = Object.values(world.projects).map((project) => project.id);
  const steps: (() => Promise<unknown>)[] = [
    () => prisma.deletedDatabase.deleteMany({ where: { organizationId: { in: orgIds } } }),
    () => prisma.project.deleteMany({ where: { id: { in: projectIds } } }),
    () => prisma.organization.deleteMany({ where: { id: { in: orgIds } } }),
    () => prisma.project.deleteMany({ where: { organizationId: { in: orgIds } } }),
    () => prisma.user.deleteMany({ where: { id: { in: userIds } } }),
    () => prisma.template.deleteMany({ where: { id: world.templateId } })
  ];
  for (const step of steps) await step().catch(() => undefined);
}
