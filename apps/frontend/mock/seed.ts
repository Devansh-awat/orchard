import { ago, sha, slugify, uid } from './ids.ts';
import type {
	MockBuild,
	MockDatabase,
	MockDeployment,
	MockEnvironment,
	MockJob,
	MockJobRun,
	MockMember,
	MockOrg,
	MockProject,
	MockState,
	MockUser,
	Role
} from './types.ts';

const ASSETS = {
	orgAvatar:
		'https://pub-6e404eda1f0844309753a4da3ef3ccca.r2.dev/organizations/6e7235cf-d703-4868-9346-84de39f66e8c.png',
	userAvatar:
		'https://pub-6e404eda1f0844309753a4da3ef3ccca.r2.dev/users/b0141f8d-69bb-43e2-a766-54d9a433c77e.webp',
	hackclubSite: 'https://assets.orchard.my/project-icons/0619ec20-62fc-44e0-9f97-17bb4a5da550.png',
	terraIcon: 'https://assets.orchard.my/project-icons/f01ab01c-3801-488b-8ad1-256d707f935d.gif',
	terraBackground:
		'https://assets.orchard.my/project-backgrounds/82672415-a9cd-437f-b2f8-f4571e5306fa.png',
	flavortown: 'https://assets.orchard.my/project-icons/cbaa0fa9-462f-4ed5-a201-329af4792120.png'
};

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function user(
	username: string,
	firstName: string,
	lastName: string,
	extra: Partial<MockUser> = {}
): MockUser {
	return {
		id: uid(`user:${username}`),
		email: `${username}@hackclub.com`,
		username,
		firstName,
		lastName,
		imageUrl: null,
		isSuperAdmin: false,
		setupCompleted: true,
		seenUpdates: [],
		createdAt: ago(60 * 24 * 400),
		...extra
	};
}

function org(slug: string, name: string, extra: Partial<MockOrg> = {}): MockOrg {
	return {
		id: uid(`org:${slug}`),
		name,
		slug,
		description: null,
		avatarUrl: null,
		plan: null,
		createdAt: ago(60 * 24 * 380),
		...extra
	};
}

function member(o: MockOrg, u: MockUser, role: Role): MockMember {
	return {
		id: uid(`member:${o.slug}:${u.username}`),
		organizationId: o.id,
		userId: u.id,
		role,
		createdAt: ago(60 * 24 * 300)
	};
}

function project(
	o: MockOrg,
	name: string,
	owner: MockUser,
	team: MockUser[],
	extra: Partial<MockProject> = {}
): MockProject {
	const slug = slugify(name);
	return {
		id: uid(`project:${o.slug}:${slug}`),
		organizationId: o.id,
		name,
		slug,
		description: null,
		icon: null,
		backgroundImage: null,
		ownerId: owner.id,
		memberIds: [owner.id, ...team.map((u) => u.id)],
		createdAt: ago(60 * 24 * 200),
		updatedAt: ago(30),
		...extra
	};
}

function environments(p: MockProject, orgSlug: string): MockEnvironment[] {
	const base = {
		projectId: p.id,
		cpuLimitMilli: null,
		memoryLimitBytes: null,
		maxPods: null,
		maxServices: null,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt
	};
	return [
		{
			...base,
			id: uid(`env:${p.id}:production`),
			name: 'Production',
			slug: 'production',
			namespace: `${orgSlug}-${p.slug}`,
			isDefault: true,
			isProduction: true,
			sharedVars: [
				{ key: 'NODE_ENV', value: 'production', secret: false },
				{ key: 'SENTRY_DSN', value: 'https://3f1c@o4504.ingest.sentry.io/77', secret: true }
			]
		},
		{
			...base,
			id: uid(`env:${p.id}:preview`),
			name: 'Preview',
			slug: 'preview',
			namespace: `${orgSlug}-${p.slug}-preview`,
			isDefault: false,
			isProduction: false,
			sharedVars: [{ key: 'NODE_ENV', value: 'development', secret: false }]
		}
	];
}

interface DeploymentSpec {
	name: string;
	host?: string | null;
	repo?: string | null;
	branch?: string;
	status?: string;
	buildStatus?: MockDeployment['buildStatus'];
	buildStep?: MockDeployment['buildStep'];
	replicas?: number;
	stopped?: boolean;
	framework?: string | null;
	cpu?: number;
	memoryMiB?: number;
	cpuUse?: number;
	memUseMiB?: number;
	crash?: MockDeployment['crash'];
	restarts?: number;
	updated?: number;
	image?: string;
	env?: MockDeployment['envVars'];
	volumes?: MockDeployment['volumes'];
}

function deployment(p: MockProject, creator: MockUser, s: DeploymentSpec): MockDeployment {
	const id = uid(`dep:${p.id}:${s.name}`);
	const repo = s.repo === undefined ? `hackclub/${p.slug}` : s.repo;
	const commit = sha(`${id}:head`).slice(0, 7);
	const building = s.buildStatus === 'building';
	const startedMs = Date.now() - 45_000;
	return {
		id,
		projectId: p.id,
		environmentId: uid(`env:${p.id}:production`),
		name: s.name,
		displayName: null,
		status: s.status ?? 'running',
		buildStatus: s.buildStatus ?? 'succeeded',
		buildStep: s.buildStep ?? (building ? 'building' : 'complete'),
		buildStepTimestamps: building
			? { queued: startedMs, cloning: startedMs + 2_000, building: startedMs + 7_000 }
			: {
					queued: Date.now() - 3_600_000,
					cloning: Date.now() - 3_598_000,
					building: Date.now() - 3_594_000,
					pushing: Date.now() - 3_560_000,
					deploying: Date.now() - 3_552_000,
					complete: Date.now() - 3_545_000
				},
		buildError: null,
		buildLogs: '',
		replicas: s.replicas ?? 1,
		stopped: s.stopped ?? false,
		image:
			s.image ??
			(repo ? `registry.orchard.my/${p.slug}/${s.name}:${commit}` : `ghcr.io/hackclub/${s.name}`),
		githubRepo: repo,
		githubBranch: repo ? (s.branch ?? 'main') : null,
		buildType: s.framework ? 'railpack' : 'dockerfile',
		framework: s.framework ?? null,
		host: s.host === undefined ? `${s.name}-${p.slug}.orchard.my` : s.host,
		port: 3000,
		cpuRequestMilli: s.cpu ?? 500,
		memoryRequestBytes: (s.memoryMiB ?? 512) * MIB,
		cpuUsageMilli: s.cpuUse ?? 42,
		memoryUsageBytes: (s.memUseMiB ?? 180) * MIB,
		envVars: s.env ?? [
			{ key: 'PORT', value: '3000', secret: false },
			{ key: 'DATABASE_URL', value: `postgres://app@${p.slug}-postgres:5432/app`, secret: true }
		],
		volumes: s.volumes ?? [],
		crash: s.crash ?? null,
		podSeed: sha(`${id}:pod`).slice(0, 10),
		podStartedAt: ago(60 * 26),
		restarts: s.restarts ?? 0,
		creatorId: creator.id,
		autoDeployEnabled: Boolean(repo),
		createdAt: ago(60 * 24 * 90),
		updatedAt: ago(s.updated ?? 60)
	};
}

const COMMITS = [
	'Fix navbar overflow on mobile',
	'Add sponsors section',
	'Bump prisma to 6.4',
	'Stream results instead of buffering',
	'Cache leaderboard for 30s',
	'Drop the legacy webhook handler',
	'Retry Slack posts on 429',
	'Tighten CSP for the embed',
	'Upgrade to Node 22',
	'Paginate the projects API'
];

function history(d: MockDeployment, authors: MockUser[], count: number): MockBuild[] {
	const out: MockBuild[] = [];
	for (let i = 0; i < count; i++) {
		const minutesAgo = 3 + i * 137 + (d.name.length % 5) * 11;
		const commitSha = i === 0 ? sha(`${d.id}:head`) : sha(`${d.id}:${i}`);
		const author = authors[i % authors.length];
		const failed = d.crash && i === 0 ? false : i === 2 && d.name.length % 2 === 0;
		const started = ago(minutesAgo + 1.2);
		out.push({
			id: uid(`build:${d.id}:${i}`),
			deploymentId: d.id,
			image: d.githubRepo
				? `registry.orchard.my/${d.name}:${commitSha.slice(0, 7)}`
				: d.image.replace(/:.*$/, '') + `:v1.${20 - i}.0`,
			branch: d.githubBranch,
			commitSha: d.githubRepo ? commitSha : null,
			commitMessage: d.githubRepo ? COMMITS[(i + d.name.length) % COMMITS.length] : null,
			commitAuthorName: `${author.firstName} ${author.lastName}`,
			commitAuthorUsername: author.username,
			triggerType: d.githubRepo ? (i % 3 === 1 ? 'manual' : 'push') : 'manual',
			triggeredById: author.id,
			status: failed ? 'failed' : 'succeeded',
			isActive: i === 0,
			buildStartedAt: started,
			buildCompletedAt: ago(minutesAgo),
			createdAt: ago(minutesAgo),
			logs: ''
		});
	}
	return out;
}

function database(
	p: MockProject,
	creator: MockUser,
	name: string,
	engine: 'postgres' | 'redis',
	sizeGiB: number,
	usedMiB: number,
	status = 'ready'
): MockDatabase {
	const id = uid(`db:${p.id}:${name}`);
	return {
		id,
		projectId: p.id,
		environmentId: uid(`env:${p.id}:production`),
		name,
		dbName: engine === 'postgres' ? 'app' : '0',
		engine,
		version: engine === 'postgres' ? '16' : '7',
		status,
		mode: engine === 'postgres' ? 'cnpg' : 'container',
		instances: engine === 'postgres' ? 2 : 1,
		storageSize: `${sizeGiB}Gi`,
		storageUsedBytes: usedMiB * MIB,
		cpuRequestMilli: 250,
		memoryRequestBytes: 512 * MIB,
		username: 'app',
		password: sha(`${id}:pw`).slice(0, 24),
		extensions: engine === 'postgres' ? ['pg_stat_statements', 'pgcrypto'] : [],
		backups:
			engine === 'postgres'
				? [0, 1, 2, 3].map((i) => ({
						id: uid(`backup:${id}:${i}`),
						name: `${name}-${20261027 - i}`,
						status: 'completed' as const,
						method: i === 1 ? ('manual' as const) : ('scheduled' as const),
						sizeBytes: Math.round(usedMiB * MIB * (0.31 - i * 0.01)),
						startedAt: ago(60 * (3 + i * 24)),
						completedAt: ago(60 * (3 + i * 24) - 2)
					}))
				: [],
		backupSchedule: { enabled: engine === 'postgres', schedule: '0 3 * * *', retentionDays: 7 },
		creatorId: creator.id,
		createdAt: ago(60 * 24 * 120),
		updatedAt: ago(60 * 26)
	};
}

export function seed(): MockState {
	const me = user('alfd', 'Alfie', 'Doe', {
		email: 'alfd@hackclub.com',
		imageUrl: ASSETS.userAvatar,
		isSuperAdmin: true
	});
	const kai = user('kai', 'Kai', 'Nakamura');
	const olive = user('olive', 'Olive', 'Park');
	const msw = user('msw', 'Max', 'Wofford');
	const dld = user('dld', 'Dana', 'Lund');
	const users = [me, kai, olive, msw, dld];

	const ysws = org('ysws', 'YSWS', {
		avatarUrl: ASSETS.orgAvatar,
		plan: 'Enterprise',
		description: 'You Ship, We Ship programs'
	});
	const hq = org('hq', 'Hack Club HQ', { plan: 'Team' });
	const orgs = [ysws, hq];

	const members = [
		member(ysws, me, 'owner'),
		member(ysws, kai, 'admin'),
		member(ysws, olive, 'member'),
		member(ysws, msw, 'member'),
		member(ysws, dld, 'member'),
		member(hq, me, 'admin'),
		member(hq, kai, 'owner')
	];

	const hackclubSite = project(ysws, 'hackclub-site', kai, [me], {
		icon: ASSETS.hackclubSite,
		description: 'hackclub.com, the main site'
	});
	const terra = project(ysws, 'terra', olive, [me, kai], {
		icon: ASSETS.terraIcon,
		backgroundImage: ASSETS.terraBackground,
		description: 'Arcade leaderboard and game servers'
	});
	const flavortown = project(ysws, 'flavortown', msw, [me], {
		icon: ASSETS.flavortown,
		description: 'Cook up a project, get a prize'
	});
	const mercury = project(ysws, 'Mercury', dld, [me], {
		description: 'Newsletter and mailer'
	});
	const slackBots = project(ysws, 'slack-bots', me, [], {
		description: 'Orpheus and friends'
	});
	const hcb = project(hq, 'hcb', kai, [me], { description: 'Fiscal sponsorship' });
	const projects = [hackclubSite, terra, flavortown, mercury, slackBots, hcb];

	const envs = projects.flatMap((p) =>
		environments(p, orgs.find((o) => o.id === p.organizationId)!.slug)
	);

	const deployments: MockDeployment[] = [
		deployment(hackclubSite, kai, {
			name: 'web',
			host: 'hackclub-site.orchard.my',
			framework: 'next',
			cpu: 1000,
			memoryMiB: 2048,
			cpuUse: 118,
			memUseMiB: 1946,
			updated: 3,
			replicas: 2
		}),
		deployment(hackclubSite, kai, {
			name: 'api',
			host: 'api.hackclub-site.orchard.my',
			buildStatus: 'building',
			buildStep: 'building',
			updated: 0.3
		}),
		deployment(terra, olive, {
			name: 'worker',
			host: 'worker-arcade-leaderboard.orchard.my',
			status: 'crashing',
			crash: {
				reason: 'OOMKilled',
				exitCode: 137,
				message: 'Exited with code 137 · out of memory'
			},
			restarts: 14,
			memoryMiB: 256,
			memUseMiB: 251,
			updated: 12
		}),
		deployment(terra, olive, {
			name: 'terra-client',
			host: 'terra.hackclub.com',
			framework: 'vite',
			updated: 60 * 5
		}),
		deployment(terra, olive, {
			name: 'game-server',
			host: null,
			repo: null,
			image: 'ghcr.io/hackclub/terra-game-server:1.8.2',
			cpu: 2000,
			memoryMiB: 4096,
			cpuUse: 870,
			memUseMiB: 2900,
			updated: 60 * 2,
			volumes: [
				{
					id: uid('vol:terra:world'),
					name: 'world',
					type: 'pvc',
					mountPath: '/data/world',
					storageSize: '20Gi',
					readOnly: false
				}
			]
		}),
		deployment(flavortown, msw, {
			name: 'web',
			host: 'flavortown.hackclub.com',
			framework: 'rails',
			replicas: 3,
			cpuUse: 320,
			memUseMiB: 1400,
			memoryMiB: 2048,
			updated: 1
		}),
		deployment(flavortown, msw, {
			name: 'api',
			host: 'api.flavortown.hackclub.com',
			updated: 48
		}),
		deployment(flavortown, msw, {
			name: 'shipwright',
			host: 'shipwright.flavortown.hackclub.com',
			updated: 89
		}),
		deployment(mercury, dld, { name: 'site', host: 'mercury.hackclub.com', updated: 26 }),
		deployment(mercury, dld, {
			name: 'mailer',
			host: null,
			updated: 123,
			cpu: 250,
			memoryMiB: 256,
			cpuUse: 4,
			memUseMiB: 96
		}),
		deployment(slackBots, me, {
			name: 'orpheus-bot',
			host: null,
			status: 'stopped',
			stopped: true,
			replicas: 0,
			cpuUse: 0,
			memUseMiB: 0,
			updated: 60 * 24 * 6
		}),
		deployment(hcb, kai, {
			name: 'hcb',
			host: 'hcb.hackclub.com',
			framework: 'rails',
			replicas: 2,
			updated: 15
		})
	];

	const builds = deployments.flatMap((d) =>
		history(d, [kai, olive, msw, dld, me], d.name === 'web' ? 6 : 4)
	);
	for (const d of deployments) {
		if (d.buildStatus !== 'building') continue;
		const startedAt = new Date(d.buildStepTimestamps?.queued ?? Date.now()).toISOString();
		builds.unshift({
			id: uid(`build:${d.id}:live`),
			deploymentId: d.id,
			image: `registry.orchard.my/${d.name}:${sha(`${d.id}:next`).slice(0, 7)}`,
			branch: d.githubBranch,
			commitSha: sha(`${d.id}:next`),
			commitMessage: 'Bump prisma to 6.4',
			commitAuthorName: 'Kai Nakamura',
			commitAuthorUsername: 'kai',
			triggerType: 'push',
			triggeredById: kai.id,
			status: 'building',
			isActive: false,
			buildStartedAt: startedAt,
			buildCompletedAt: null,
			createdAt: startedAt,
			logs: ''
		});
	}
	const workerFail = builds.find((b) => b.deploymentId === deployments[2].id && !b.isActive);
	if (workerFail) {
		workerFail.status = 'failed';
		workerFail.commitMessage = 'Stream results instead of buffering';
		workerFail.branch = 'feat/stream';
	}

	const databases: MockDatabase[] = [
		database(hackclubSite, kai, 'postgres', 'postgres', 10, 2150),
		database(terra, olive, 'leaderboard', 'postgres', 5, 610),
		database(flavortown, msw, 'postgres', 'postgres', 20, 4915),
		database(flavortown, msw, 'redis', 'redis', 1, 212),
		database(flavortown, msw, 'analytics', 'postgres', 10, 1331),
		database(flavortown, msw, 'sessions', 'redis', 1, 64),
		database(flavortown, msw, 'votes', 'postgres', 5, 702, 'provisioning'),
		{ ...database(mercury, dld, 'postgres', 'postgres', 5, 318), instances: 1, memoryRequestBytes: 256 * MIB },
		database(hcb, kai, 'postgres', 'postgres', 50, 18_400)
	];

	const mailer = deployments.find((d) => d.name === 'mailer')!;
	const jobs: MockJob[] = [
		{
			id: uid('job:terra:nightly-sync'),
			projectId: terra.id,
			name: 'nightly-sync',
			description: 'Sync arcade scores from Airtable',
			scheduleCron: '0 3 * * *',
			timeZone: 'America/New_York',
			enabled: false,
			concurrencyPolicy: 'forbid',
			runTimeoutSeconds: 1800,
			steps: [
				{
					id: uid('step:nightly-sync:0'),
					stepOrder: 0,
					name: 'sync',
					type: 'script',
					deploymentId: null,
					image: 'node:22-slim',
					command: null,
					script:
						"const res = await fetch(process.env.AIRTABLE_URL);\nconsole.log('synced', (await res.json()).records.length);",
					scriptRuntime: 'node',
					envVars: [{ key: 'AIRTABLE_URL', value: 'https://api.airtable.com/v0/app/scores' }],
					cpuRequestMilli: 250,
					memoryRequestBytes: String(256 * MIB),
					timeoutSeconds: 600,
					retries: 1
				}
			],
			createdAt: ago(60 * 24 * 60),
			updatedAt: ago(60 * 9)
		},
		{
			id: uid('job:mercury:digest'),
			projectId: mercury.id,
			name: 'weekly-digest',
			description: 'Build and send the weekly newsletter',
			scheduleCron: '0 14 * * 5',
			timeZone: 'UTC',
			enabled: true,
			concurrencyPolicy: 'forbid',
			runTimeoutSeconds: 3600,
			steps: [
				{
					id: uid('step:digest:0'),
					stepOrder: 0,
					name: 'render',
					type: 'app',
					deploymentId: mailer.id,
					image: null,
					command: 'bin/render-digest',
					script: null,
					scriptRuntime: null,
					envVars: [],
					cpuRequestMilli: null,
					memoryRequestBytes: null,
					timeoutSeconds: 900,
					retries: 0
				},
				{
					id: uid('step:digest:1'),
					stepOrder: 1,
					name: 'send',
					type: 'app',
					deploymentId: mailer.id,
					image: null,
					command: 'bin/send-digest',
					script: null,
					scriptRuntime: null,
					envVars: [],
					cpuRequestMilli: null,
					memoryRequestBytes: null,
					timeoutSeconds: 900,
					retries: 2
				}
			],
			createdAt: ago(60 * 24 * 120),
			updatedAt: ago(60 * 24 * 3)
		},
		{
			id: uid('job:flavortown:prune'),
			projectId: flavortown.id,
			name: 'prune-sessions',
			description: null,
			scheduleCron: '*/30 * * * *',
			timeZone: 'UTC',
			enabled: true,
			concurrencyPolicy: 'allow',
			runTimeoutSeconds: 300,
			steps: [
				{
					id: uid('step:prune:0'),
					stepOrder: 0,
					name: 'prune',
					type: 'image',
					deploymentId: null,
					image: 'redis:7-alpine',
					command: 'redis-cli -h sessions --scan --pattern "sess:*" | head',
					script: null,
					scriptRuntime: null,
					envVars: [],
					cpuRequestMilli: 100,
					memoryRequestBytes: String(64 * MIB),
					timeoutSeconds: 120,
					retries: 0
				}
			],
			createdAt: ago(60 * 24 * 30),
			updatedAt: ago(60 * 24 * 2)
		}
	];

	const jobRuns: MockJobRun[] = [];
	const runPlan: Record<string, { status: MockJobRun['status']; minutesAgo: number }[]> = {
		[jobs[0].id]: [
			{ status: 'failed', minutesAgo: 60 * 9 },
			{ status: 'succeeded', minutesAgo: 60 * 33 },
			{ status: 'succeeded', minutesAgo: 60 * 57 }
		],
		[jobs[1].id]: [
			{ status: 'succeeded', minutesAgo: 60 * 24 * 4 },
			{ status: 'succeeded', minutesAgo: 60 * 24 * 11 },
			{ status: 'failed', minutesAgo: 60 * 24 * 18 }
		],
		[jobs[2].id]: [
			{ status: 'running', minutesAgo: 0.4 },
			{ status: 'succeeded', minutesAgo: 30 },
			{ status: 'succeeded', minutesAgo: 60 },
			{ status: 'succeeded', minutesAgo: 90 },
			{ status: 'timed_out', minutesAgo: 120 }
		]
	};
	for (const job of jobs) {
		const plan = runPlan[job.id] ?? [];
		plan.forEach((r, i) => {
			const number = plan.length - i + 40;
			const runId = uid(`run:${job.id}:${number}`);
			const running = r.status === 'running';
			const startedAt = ago(r.minutesAgo);
			const finishedAt = running ? null : ago(r.minutesAgo - 0.8);
			jobRuns.push({
				id: runId,
				jobId: job.id,
				number,
				status: r.status,
				trigger: i === 1 ? 'manual' : 'cron',
				startedAt,
				finishedAt,
				createdAt: startedAt,
				currentStepOrder: running ? 0 : null,
				errorMessage:
					r.status === 'failed'
						? 'Step "sync" exited with code 1'
						: r.status === 'timed_out'
							? 'Run exceeded its 5m timeout'
							: null,
				scheduledFor: i === 1 ? null : startedAt,
				triggeredById: i === 1 ? me.id : null,
				steps: job.steps.map((s, si) => {
					const lastStep = si === job.steps.length - 1;
					const stepStatus =
						r.status === 'failed' && lastStep
							? 'failed'
							: running
								? si === 0
									? 'running'
									: 'pending'
								: r.status === 'timed_out'
									? 'timed_out'
									: 'succeeded';
					return {
						id: uid(`runstep:${runId}:${si}`),
						stepOrder: s.stepOrder,
						name: s.name,
						type: s.type,
						resolvedImage: s.image ?? `registry.orchard.my/${mailer.name}:latest`,
						command: s.command,
						status: stepStatus,
						exitCode: stepStatus === 'failed' ? 1 : stepStatus === 'succeeded' ? 0 : null,
						reason: stepStatus === 'failed' ? 'Error' : null,
						logsTruncated: false,
						startedAt: stepStatus === 'pending' ? null : startedAt,
						finishedAt: stepStatus === 'running' || stepStatus === 'pending' ? null : finishedAt,
						logs:
							stepStatus === 'failed'
								? `starting ${s.name}\nfetching records...\nError: request to api.airtable.com failed, reason: ECONNRESET\n    at ClientRequest.<anonymous> (node:internal/http:1)\n`
								: `starting ${s.name}\nprocessed 1284 records in 2.3s\ndone\n`
					};
				})
			});
		});
	}

	return {
		signedIn: true,
		meId: me.id,
		users,
		orgs,
		members,
		projects,
		environments: envs,
		deployments,
		builds,
		databases,
		jobs,
		jobRuns,
		ssoProviders: [
			{
				id: uid('sso:ysws:hackclub'),
				organizationId: ysws.id,
				slug: 'hack-club',
				name: 'Hack Club',
				preset: 'generic',
				protocol: 'oidc',
				enabled: true,
				buttonLabel: 'Continue with Hack Club',
				iconUrl: null,
				sortOrder: 0,
				issuerUrl: 'https://auth.hackclub.com',
				clientId: 'orchard-mock',
				clientSecret: 'stored',
				scopes: 'openid email profile',
				authorizationUrl: null,
				tokenUrl: null,
				userinfoUrl: null,
				samlEntryPoint: null,
				samlIssuer: null,
				samlIdpEntityId: null,
				samlCertificate: null,
				samlMetadataUrl: null,
				jitProvisioning: true,
				defaultRole: 'member',
				allowedDomains: ['hackclub.com'],
				requireVerifiedEmail: true,
				lastUsedAt: ago(60 * 3),
				createdAt: ago(60 * 24 * 40),
				updatedAt: ago(60 * 24 * 2)
			}
		],
		pinned: [
			{ type: 'project', id: hackclubSite.id },
			{ type: 'deployment', id: deployments[3].id }
		]
	};
}

export { GIB, MIB };
