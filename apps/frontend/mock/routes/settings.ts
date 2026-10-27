import { freshId, sha, uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, type Router } from '../router.ts';
import { memberRow, orgRow, userRow } from '../serialize.ts';
import type { Store } from '../store.ts';

const MIB = 1024 ** 2;

function usageBreakdown(store: Store, orgId: string, userId?: string) {
	const pids = new Set(store.projectsOf(orgId).map((p) => p.id));
	const rows = [
		...store.state.deployments
			.filter((d) => pids.has(d.projectId) && (!userId || d.creatorId === userId))
			.map((d) => ({
				kind: 'deployment' as const,
				id: d.id,
				name: d.name,
				projectId: d.projectId,
				projectName: store.project(d.projectId)!.name,
				cpuMilli: d.stopped ? 0 : d.cpuRequestMilli * d.replicas,
				memoryBytes: d.stopped ? 0 : d.memoryRequestBytes * d.replicas,
				replicas: d.stopped ? 0 : d.replicas
			})),
		...store.state.databases
			.filter((db) => pids.has(db.projectId) && (!userId || db.creatorId === userId))
			.map((db) => ({
				kind: 'database' as const,
				id: db.id,
				name: db.name,
				projectId: db.projectId,
				projectName: store.project(db.projectId)!.name,
				cpuMilli: db.cpuRequestMilli * db.instances,
				memoryBytes: db.memoryRequestBytes * db.instances,
				replicas: db.instances
			}))
	];
	return {
		cpuMilli: rows.reduce((a, r) => a + r.cpuMilli, 0),
		memoryBytes: rows.reduce((a, r) => a + r.memoryBytes, 0),
		breakdown: rows
	};
}

export function settingsRoutes(r: Router, { store }: MockContext) {
	const org = (id: string) => store.org(id);
	const CAP = { cpuLimitMilli: 64_000, memoryLimitBytes: 128 * 1024 * MIB };

	r.get('/organizations/slug/:slug', ({ params }) => {
		const o = org(params.slug);
		if (!o) return notFound('Organization not found');
		return {
			...orgRow(store, o),
			subdomain: o.slug,
			members: store.membersOf(o.id).map((m) => memberRow(store, m))
		};
	});
	r.get('/organizations/:id', ({ params }) => {
		const o = org(params.id);
		return o ? orgRow(store, o) : notFound();
	});
	r.patch('/organizations/:id', ({ params, body }) => {
		const o = org(params.id);
		if (!o) return notFound();
		if (body?.name) o.name = String(body.name);
		if (body?.description !== undefined) o.description = body.description;
		store.emitOrg(o.id, 'membership.changed');
		return orgRow(store, o);
	});
	r.get('/organizations/:id/invitations', () => [
		{
			id: uid('inv:1'),
			email: 'new-hire@hackclub.com',
			role: 'member',
			createdAt: store.createdAgo(60 * 20),
			expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
			inviter: { firstName: 'Alfie', lastName: 'Doe', username: 'alfd', email: 'alfd@hackclub.com' }
		}
	]);
	r.post('/organizations/:id/members', ({ params }) => {
		const o = org(params.id);
		if (o) store.emitOrg(o.id, 'membership.changed');
		return { ok: true, invited: true };
	});
	r.patch('/organizations/:id/members/:memberId', ({ params, body }) => {
		const m = store.state.members.find((x) => x.id === params.memberId);
		if (!m) return notFound();
		if (body?.role) m.role = body.role;
		store.emitOrg(m.organizationId, 'membership.changed', m.userId);
		return memberRow(store, m);
	});
	r.delete('/organizations/:id/members/:memberId', ({ params }) => {
		const m = store.state.members.find((x) => x.id === params.memberId);
		if (!m) return notFound();
		store.state.members = store.state.members.filter((x) => x.id !== m.id);
		store.emitOrg(m.organizationId, 'membership.changed', m.userId);
		return { ok: true };
	});
	r.get('/organizations/:id/backup-settings', () => ({
		endpoint: 'https://r2.orchard.my',
		bucket: 'orchard-backups',
		region: 'auto',
		accessKeyConfigured: true,
		accessKeyLast4: 'f00d',
		secretKeyConfigured: true,
		databasePublicIp: null,
		instanceDefaultPublicIp: '203.0.113.10'
	}));
	r.get('/organizations/:id/notification-channels', () => [
		{
			id: uid('chan:slack'),
			name: '#ysws-alerts',
			type: 'slack',
			config: { urlConfigured: true, urlPreview: 'https://hooks.slack.com/services/T0…/B0…' },
			enabled: true,
			ruleCount: 3,
			health: { state: 'healthy' },
			lastDelivery: {
				status: 'sent',
				error: null,
				event: 'deployment.crashing',
				createdAt: store.createdAgo(12)
			},
			scopeType: 'organization',
			scopeId: null,
			scopeLabel: null
		}
	]);
	r.post('/organizations/:id/notification-channels/:cid/test', () => ({ success: true }));
	r.get('/organizations/:id/scim/tokens', () => ({
		baseUrl: 'https://orchard.my/apiv1/scim/v2',
		tokens: []
	}));
	r.get('/organizations/:id/status-pages', () => []);
	r.get('/organizations/:id/status-pages/options', ({ params }) => {
		const o = org(params.id);
		if (!o) return [];
		const pids = new Set(store.projectsOf(o.id).map((p) => p.id));
		return store.state.deployments
			.filter((d) => pids.has(d.projectId))
			.map((d) => ({
				kind: 'deployment',
				resourceId: d.id,
				name: d.name,
				project: store.project(d.projectId)!.name
			}));
	});
	r.get('/organizations/:id/sso', ({ params }) => ({
		settings: {
			organizationId: params.id,
			platformEnabled: true,
			enabled: false,
			enforced: false,
			loginLogoUrl: null,
			loginPrimaryColor: null,
			loginBgColor: null,
			loginWelcomeText: null,
			loginTagline: null
		},
		providers: [],
		domains: [],
		presets: [],
		loginUrl: null
	}));
	r.get('/audit-logs/organization/:orgId', ({ params }) => {
		const o = org(params.orgId);
		if (!o) return { entries: [], nextCursor: null };
		const pids = new Set(store.projectsOf(o.id).map((p) => p.id));
		const entries = store.state.builds
			.filter((b) => {
				const d = store.deployment(b.deploymentId);
				return d && pids.has(d.projectId);
			})
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 30)
			.map((b) => {
				const d = store.deployment(b.deploymentId)!;
				const actor = store.user(b.triggeredById);
				return {
					id: uid(`audit:${b.id}`),
					createdAt: b.createdAt,
					action: b.triggerType === 'push' ? 'deployment.build' : 'deployment.redeploy',
					actorUserId: actor?.id ?? null,
					actorEmail: actor?.email ?? null,
					organizationId: o.id,
					projectId: d.projectId,
					deploymentId: d.id,
					targetType: 'deployment',
					targetId: d.id,
					targetLabel: d.name,
					metadata: { commitSha: b.commitSha, branch: b.branch },
					actor: actor ? { ...userRow(actor) } : null
				};
			});
		return { entries, nextCursor: null };
	});

	r.get('/organizations/:orgId/quota/me', ({ params }) => {
		const o = org(params.orgId);
		if (!o) return notFound();
		const usage = usageBreakdown(store, o.id, store.state.meId);
		const total = usageBreakdown(store, o.id);
		return {
			allowance: {
				cpuMilli: null,
				memoryBytes: null,
				source: { cpu: 'unlimited', memory: 'unlimited' }
			},
			usage,
			orgCap: CAP,
			effectiveLimit: {
				cpuMilli: CAP.cpuLimitMilli - total.cpuMilli,
				memoryBytes: CAP.memoryLimitBytes - total.memoryBytes
			},
			org: { defaultPodCpuMilli: 500, defaultPodMemoryBytes: 512 * MIB }
		};
	});
	r.get('/organizations/:orgId/quota', ({ params }) => {
		const o = org(params.orgId);
		if (!o) return notFound();
		const total = usageBreakdown(store, o.id);
		return {
			org: { id: o.id, name: o.name, ...CAP, maxPods: 200, maxServices: 100 },
			usage: {
				cpuMilli: total.cpuMilli,
				memoryBytes: total.memoryBytes,
				pods: total.breakdown.reduce((a, r) => a + r.replicas, 0),
				services: total.breakdown.length
			}
		};
	});
	r.get('/organizations/:orgId/quota/projects', ({ params }) => {
		const o = org(params.orgId);
		if (!o) return notFound();
		const rows = usageBreakdown(store, o.id).breakdown;
		return {
			projects: store.projectsOf(o.id).map((p) => {
				const mine = rows.filter((r) => r.projectId === p.id);
				return {
					id: p.id,
					name: p.name,
					slug: p.slug,
					namespace: `${o.slug}-${p.slug}`,
					cpuLimitMilli: null,
					memoryLimitBytes: null,
					maxPods: null,
					maxServices: null,
					usage: {
						cpuMilli: mine.reduce((a, r) => a + r.cpuMilli, 0),
						memoryBytes: mine.reduce((a, r) => a + r.memoryBytes, 0),
						pods: mine.reduce((a, r) => a + r.replicas, 0)
					}
				};
			})
		};
	});
	r.get('/organizations/:orgId/quota/members', ({ params }) => {
		const o = org(params.orgId);
		if (!o) return notFound();
		const total = usageBreakdown(store, o.id);
		return {
			org: { ...CAP, defaultMemberCpuMilli: null, defaultMemberMemoryBytes: null },
			commitment: { cpuMilli: total.cpuMilli, memoryBytes: total.memoryBytes },
			members: store.membersOf(o.id).map((m) => {
				const u = usageBreakdown(store, o.id, m.userId);
				return {
					user: userRow(store.user(m.userId)!),
					role: m.role,
					allowance: {
						cpuMilli: null,
						memoryBytes: null,
						source: { cpu: 'unlimited', memory: 'unlimited' }
					},
					usage: { cpuMilli: u.cpuMilli, memoryBytes: u.memoryBytes }
				};
			})
		};
	});
	r.get('/organizations/:orgId/metrics/provisioning', ({ params }) => {
		const o = org(params.orgId);
		if (!o) return { rows: [] };
		const pids = new Set(store.projectsOf(o.id).map((p) => p.id));
		return {
			rows: store.state.deployments
				.filter((d) => pids.has(d.projectId) && !d.stopped)
				.map((d) => {
					const cpuUtil = d.cpuUsageMilli / d.cpuRequestMilli;
					const memUtil = d.memoryUsageBytes / d.memoryRequestBytes;
					return {
						kind: 'deployment',
						id: d.id,
						name: d.name,
						projectId: d.projectId,
						projectName: store.project(d.projectId)!.name,
						namespace: `${o.slug}-${store.project(d.projectId)!.slug}`,
						requestedCpuMilli: d.cpuRequestMilli,
						requestedMemoryBytes: d.memoryRequestBytes,
						actualCpuMilliP95: Math.round(d.cpuUsageMilli * 1.3),
						actualMemoryBytesP95: Math.round(d.memoryUsageBytes * 1.05),
						cpuUtilization: +cpuUtil.toFixed(2),
						memoryUtilization: +memUtil.toFixed(2),
						verdict: memUtil > 0.9 ? 'under' : cpuUtil < 0.15 && memUtil < 0.3 ? 'over' : 'ok'
					};
				})
		};
	});

	r.get('/github/app/install', () => ({
		url: 'https://github.com/apps/orchard-mock/installations/new'
	}));
	r.get('/auth/passkeys', () => ({ passkeys: [] }));
	r.get('/auth/sessions', () => ({
		sessions: [
			{
				id: uid('session:current'),
				ipAddress: '127.0.0.1',
				deviceName: 'Chrome on macOS',
				location: 'Localhost',
				authMethod: 'mock',
				lastActiveAt: new Date().toISOString(),
				createdAt: store.createdAgo(60 * 24),
				isCurrent: true
			}
		]
	}));
	r.post('/auth/sessions/revoke-all', () => ({ revokedCount: 0 }));
	r.get('/health', () => ({ status: 'ok', version: 'mock' }));
	r.get('/auth/tokens', () => [
		{
			id: uid('token:cli'),
			name: 'laptop cli',
			lastUsedAt: store.createdAgo(90),
			expiresAt: null,
			createdAt: store.createdAgo(60 * 24 * 30)
		}
	]);
	r.post('/auth/tokens', () => ({
		id: freshId(),
		token: `orch_mock_${sha(String(Date.now())).slice(0, 32)}`
	}));
	r.get('/users/me/git-connections', () => []);
	r.get('/users/me/git-connections/oauth', () => ({ gitlab: null, bitbucket: null }));
	r.get('/users/me/notification-settings', () => ({
		global: {
			deploys: 'subscribed',
			health: 'always',
			jobs: 'subscribed',
			data: 'always',
			security: 'always'
		},
		defaultValue: 'subscribed',
		overrides: [],
		extensionCategories: []
	}));
	r.get('/users/me/notification-destinations', () => []);
	r.get('/tailscale/status', () => ({ linked: false, tailnet: null }));
}
