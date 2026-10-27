import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uid } from './ids.ts';
import type { Store } from './store.ts';
import type {
	MockDatabase,
	MockDeployment,
	MockEnvironment,
	MockMember,
	MockOrg,
	MockProject,
	MockSsoProvider,
	MockUser
} from './types.ts';

const UPDATES_DIR = fileURLToPath(new URL('../src/lib/updates/', import.meta.url));

const SECRET_MASK = '••••••••';

export function ssoProviderRow(p: MockSsoProvider) {
	const usable =
		p.protocol === 'saml'
			? Boolean(p.samlEntryPoint && p.samlCertificate)
			: p.protocol === 'oauth2'
				? Boolean(p.clientId && p.authorizationUrl && p.tokenUrl && p.userinfoUrl)
				: Boolean(p.issuerUrl && p.clientId);
	return {
		...p,
		clientSecret: p.clientSecret ? SECRET_MASK : null,
		samlCertificate: p.samlCertificate ? SECRET_MASK : null,
		usable,
		callbackUrl: `http://localhost:3000/apiv1/sso/callback/${p.id}`,
		entityId: `orchard-sso-${p.organizationId ?? 'instance'}-${p.id}`,
		metadataUrl:
			p.protocol === 'saml' ? `http://localhost:3000/apiv1/sso/providers/${p.id}/metadata` : null
	};
}

export function allUpdateIds(): string[] {
	try {
		return readdirSync(UPDATES_DIR)
			.filter((f) => f.endsWith('.md'))
			.map((f) => /^id:\s*['"]?([^'"\n]+)/m.exec(readFileSync(UPDATES_DIR + f, 'utf8'))?.[1])
			.filter((id): id is string => Boolean(id));
	} catch {
		return [];
	}
}

export function creator(u: MockUser | undefined) {
	if (!u) return null;
	return {
		id: u.id,
		username: u.username,
		firstName: u.firstName,
		lastName: u.lastName,
		imageUrl: u.imageUrl
	};
}

export function userRow(u: MockUser) {
	return {
		id: u.id,
		email: u.email,
		username: u.username,
		firstName: u.firstName,
		lastName: u.lastName,
		imageUrl: u.imageUrl,
		createdAt: u.createdAt
	};
}

export function me(store: Store, u: MockUser) {
	return {
		...userRow(u),
		name: `${u.firstName} ${u.lastName}`,
		fullName: `${u.firstName} ${u.lastName}`,
		primaryEmailAddress: { emailAddress: u.email },
		externalAuthId: `mock_${u.username}`,
		hackClubId: null,
		setupCompleted: u.setupCompleted,
		seenUpdates: u.seenUpdates,
		...(u.isSuperAdmin ? { isSuperAdmin: true } : {}),
		hasPassword: false,
		passkeyCount: 0,
		totpEnabled: false,
		timezone: 'America/New_York',
		organizations: store.myOrgs().map((o) => ({ id: o.id, slug: o.slug, name: o.name }))
	};
}

export function orgRow(store: Store, o: MockOrg) {
	return {
		id: o.id,
		name: o.name,
		slug: o.slug,
		description: o.description,
		avatarUrl: o.avatarUrl,
		plan: o.plan,
		myRole: store.myRole(o.id),
		createdAt: o.createdAt,
		updatedAt: o.createdAt,
		ssoEnforced: false,
		backupR2Bucket: null,
		backupR2Endpoint: null,
		backupR2AccessKeyConfigured: false,
		backupR2SecretKeyConfigured: false,
		backupR2AccessKeyLast4: null,
		_count: {
			projects: store.projectsOf(o.id).length,
			members: store.membersOf(o.id).length
		}
	};
}

export function memberRow(store: Store, m: MockMember) {
	const u = store.user(m.userId)!;
	return {
		id: m.id,
		organizationId: m.organizationId,
		userId: m.userId,
		role: m.role,
		addedAt: m.createdAt,
		createdAt: m.createdAt,
		projects: store
			.projectsOf(m.organizationId)
			.filter((p) => p.memberIds.includes(m.userId))
			.map((p) => ({
				projectMemberId: uid(`pm:${p.id}:${m.userId}`),
				id: p.id,
				name: p.name,
				slug: p.slug,
				role: p.ownerId === m.userId ? 'admin' : 'member'
			})),
		user: { ...userRow(u), externalAuthId: `mock_${u.username}` }
	};
}

export function ingress(d: MockDeployment) {
	if (!d.host) return [];
	return [
		{
			id: uid(`ing:${d.id}`),
			name: `${d.name}-ingress`,
			host: d.host,
			path: '/',
			pathType: 'Prefix',
			tlsSecretName: `${d.name}-tls`,
			entrypoints: ['websecure'],
			tlsEnabled: true,
			url: `https://${d.host}`,
			protectionMode: 'none',
			deploymentId: d.id,
			projectId: d.projectId,
			environmentId: d.environmentId,
			annotations: {},
			createdAt: d.createdAt,
			updatedAt: d.updatedAt
		}
	];
}

function projectRef(p: MockProject) {
	return { id: p.id, name: p.name, slug: p.slug, organizationId: p.organizationId };
}

export function deploymentSummary(store: Store, d: MockDeployment) {
	const p = store.project(d.projectId)!;
	return {
		id: d.id,
		name: d.name,
		displayName: d.displayName,
		status: d.status,
		buildStatus: d.buildStatus,
		image: d.image,
		githubRepo: d.githubRepo,
		githubBranch: d.githubBranch,
		updatedAt: d.updatedAt,
		replicas: d.replicas,
		stopped: d.stopped,
		faviconUrl: null,
		ingresses: ingress(d),
		project: projectRef(p),
		creator: creator(store.user(d.creatorId))
	};
}

export function databaseSummary(store: Store, db: MockDatabase) {
	const p = store.project(db.projectId)!;
	return {
		id: db.id,
		name: db.name,
		dbName: db.dbName,
		status: db.status,
		mode: db.mode,
		type: db.engine,
		createdAt: db.createdAt,
		updatedAt: db.updatedAt,
		project: projectRef(p),
		creator: creator(store.user(db.creatorId))
	};
}

export function projectMember(store: Store, p: MockProject, userId: string) {
	const u = store.user(userId)!;
	const orgRole = store.membersOf(p.organizationId).find((m) => m.userId === userId)?.role ?? null;
	return {
		id: uid(`pm:${p.id}:${userId}`),
		projectId: p.id,
		userId,
		orgRole,
		role: {
			id: uid(`role:${userId === p.ownerId ? 'admin' : 'member'}`),
			name: userId === p.ownerId ? 'admin' : 'member'
		},
		createdAt: p.createdAt,
		user: userRow(u)
	};
}

export function projectMeta(store: Store, p: MockProject) {
	const o = store.org(p.organizationId)!;
	const deps = store.deploymentsOf(p.id);
	return {
		id: p.id,
		name: p.name,
		slug: p.slug,
		description: p.description,
		namespace: null,
		repositoryUrl: null,
		icon: p.icon,
		backgroundImage: p.backgroundImage,
		ownerId: p.ownerId,
		owner: { username: store.user(p.ownerId)?.username ?? null },
		organizationId: p.organizationId,
		organization: { id: o.id, name: o.name, slug: o.slug },
		members: p.memberIds.map((id) => projectMember(store, p, id)),
		deployments: deps.map((d) => ({
			id: d.id,
			name: d.name,
			displayName: d.displayName,
			status: d.status,
			ingresses: ingress(d).map((i) => ({ id: i.id, host: i.host }))
		})),
		_count: {
			deployments: deps.length,
			databases: store.databasesOf(p.id).length,
			ingresses: deps.filter((d) => d.host).length
		},
		createdAt: p.createdAt,
		updatedAt: p.updatedAt
	};
}

export function environment(store: Store, e: MockEnvironment) {
	const { sharedVars: _sharedVars, ...rest } = e;
	const deps = store.deploymentsOf(e.projectId).filter((d) => d.environmentId === e.id);
	return {
		...rest,
		_count: {
			deployments: deps.length,
			databases: store.databasesOf(e.projectId).filter((d) => d.environmentId === e.id).length,
			ingresses: deps.filter((d) => d.host).length
		}
	};
}

export function access(store: Store, p: MockProject) {
	const orgRole = store.myRole(p.organizationId);
	const isAdmin = orgRole === 'owner' || orgRole === 'admin';
	const isOwner = p.ownerId === store.state.meId;
	return {
		orgRole,
		projectRole: isOwner ? 'admin' : p.memberIds.includes(store.state.meId) ? 'member' : null,
		source: isAdmin ? 'orgAdmin' : 'projectMember',
		canView: true,
		canEdit: true,
		canManageMembers: isAdmin || isOwner,
		canDelete: isAdmin || isOwner,
		canTransferOwnership: isAdmin || isOwner
	};
}
