import { freshId, sha, slugify } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import { creator, databaseSummary } from '../serialize.ts';
import type { Store } from '../store.ts';
import type { MockDatabase } from '../types.ts';
import { recoveryFields, trashDatabase } from './recovery.ts';

const MIB = 1024 ** 2;

function parseGi(size: string) {
	const m = /^(\d+)(Mi|Gi|Ti)$/.exec(size);
	if (!m) return 10 * 1024 * MIB;
	const n = Number(m[1]);
	return m[2] === 'Mi' ? n * MIB : m[2] === 'Gi' ? n * 1024 * MIB : n * 1024 * 1024 * MIB;
}

function pods(db: MockDatabase) {
	if (db.status === 'stopped' || db.status === 'provisioning') return [];
	return Array.from({ length: db.instances }, (_, i) => ({
		name: `${db.name}-cluster-${i + 1}`,
		status: db.status === 'restarting' ? 'Pending' : 'Running',
		podIp: `10.42.${3 + i}.${(db.name.length * 17 + i * 31) % 250}`,
		role: i === 0 ? 'primary' : 'replica',
		containers: [
			{
				name: db.engine === 'postgres' ? 'postgres' : 'redis',
				image:
					db.engine === 'postgres'
						? `ghcr.io/cloudnative-pg/postgresql:${db.version}.4-system-trixie`
						: 'redis:7.4-alpine',
				ready: db.status === 'ready'
			}
		]
	}));
}

function verdictOf(db: MockDatabase, oom: boolean) {
	if (db.engine !== 'postgres') return {};
	if (db.status === 'stopped') return { verdict: 'hibernated', verdictReasons: [] };
	if (db.status === 'provisioning' || db.status === 'restoring')
		return { verdict: 'unknown', verdictReasons: [] };
	if (db.status !== 'ready')
		return { verdict: 'down', verdictReasons: ['No instance is accepting connections'] };
	if (oom)
		return {
			verdict: 'degraded',
			verdictReasons: [
				'The primary ran out of memory 4 minutes ago and restarted (exit 137)',
				'512 MB is the smallest size that holds shared_buffers and connections'
			]
		};
	if (!db.backups.some((b) => b.status === 'completed'))
		return { verdict: 'unprotected', verdictReasons: ['There is no backup to restore from yet'] };
	return { verdict: 'healthy', verdictReasons: [] };
}

function liveStatus(db: MockDatabase) {
	const capacity = parseGi(db.storageSize);
	const ready = db.status === 'ready';
	const oom = ready && db.engine === 'postgres' && db.memoryRequestBytes < 512 * MIB;
	return {
		...verdictOf(db, oom),
		...(oom
			? {
					message: 'OOMKilled',
					lastTerminationReason: 'OOMKilled',
					lastTerminationExitCode: 137,
					lastTerminationAt: new Date(Date.now() - 4 * 60_000).toISOString()
				}
			: {}),
		exists: db.status !== 'provisioning',
		ready,
		phase:
			db.status === 'stopped'
				? 'hibernated'
				: ready
					? 'Cluster in healthy state'
					: 'Setting up primary',
		replicas: db.instances,
		readyReplicas: ready ? db.instances : 0,
		currentPrimary: db.status === 'stopped' ? null : `${db.name}-cluster-1`,
		restartCount: oom ? 142 : 0,
		size: `${Math.round(db.storageUsedBytes / MIB)} MB`,
		connections: ready ? 4 + (db.name.length % 9) : 0,
		statsAt: new Date().toISOString(),
		volume: {
			usedBytes: db.storageUsedBytes,
			capacityBytes: capacity,
			used: `${(db.storageUsedBytes / 1024 ** 3).toFixed(1)} GiB`,
			capacity: db.storageSize,
			percent: Math.round((db.storageUsedBytes / capacity) * 100)
		},
		walPendingSegments: 0,
		writeGuard: false,
		resumeWritesAt: null,
		archiving: db.engine === 'postgres' ? { ok: true, message: null, since: null } : null,
		firstRecoverabilityPoint: db.backups.at(-1)?.completedAt ?? null,
		lastSuccessfulBackup: db.backups[0]?.completedAt ?? null,
		danglingPVC: [],
		unusablePVC: []
	};
}

export function databaseDetail(store: Store, db: MockDatabase, fast = false) {
	const p = store.project(db.projectId)!;
	const o = store.org(p.organizationId)!;
	const env = store.state.environments.find((e) => e.id === db.environmentId);
	const namespace = env?.namespace ?? `${o.slug}-${p.slug}`;
	const host = `${db.name}-cluster-rw.${namespace}.svc.cluster.local`;
	const port = db.engine === 'postgres' ? 5432 : 6379;
	const connectionString =
		db.engine === 'postgres'
			? `postgresql://${db.username}:${db.password}@${host}:${port}/${db.dbName}`
			: `redis://default:${db.password}@${host}:${port}/0`;
	const u = store.user(db.creatorId);
	return {
		...databaseSummary(store, db),
		dbUser: db.username,
		dbPassword: null,
		passwordSet: true,
		host,
		port,
		pgMajor: db.engine === 'postgres' ? Number(db.version) : undefined,
		namespace,
		containerName: db.mode === 'container' ? db.name : null,
		clusterName: `${db.name}-cluster`,
		storageSize: db.storageSize,
		publicEnabled: false,
		publicIp: null,
		publicPort: null,
		publicHostname: null,
		publicConnectionString: null,
		connectionString: connectionString.replace(db.password, '****'),
		internalHost: `${host}:${port}`,
		endpoints:
			db.engine === 'postgres'
				? {
						rw: `${db.name}-cluster-rw.${namespace}.svc`,
						ro: `${db.name}-cluster-ro.${namespace}.svc`,
						r: `${db.name}-cluster-r.${namespace}.svc`
					}
				: null,
		cpuRequestMilli: db.cpuRequestMilli,
		memoryRequestBytes: String(db.memoryRequestBytes),
		replicas: db.instances,
		maxReplicas: 5,
		backupsEnabled: db.backupSchedule.enabled,
		backupScheduleCron: db.backupSchedule.enabled ? db.backupSchedule.schedule : null,
		environmentId: db.environmentId,
		...recoveryFields(db),
		pods: fast ? [] : pods(db),
		liveStatus: fast ? undefined : liveStatus(db),
		project: { id: p.id, name: p.name, slug: p.slug, organization: { id: o.id, slug: o.slug } },
		creator: u ? { ...creator(u), email: u.email } : null
	};
}

function series(start: number, end: number, step: number, base: number, wobble: number) {
	const out: { x: number; y: number }[] = [];
	for (let t = start - (start % step); t <= end; t += step) {
		const phase = t / 600_000;
		out.push({
			x: t,
			y: Math.max(
				0,
				+(base + Math.sin(phase) * wobble + Math.sin(phase * 3.7) * wobble * 0.3).toFixed(2)
			)
		});
	}
	return out;
}

export function metricsWindow(query: URLSearchParams) {
	const end = Number(query.get('end')) || Date.now();
	const start = Number(query.get('start')) || end - 3_600_000;
	const step = Number(query.get('step')) || Math.max(15_000, Math.floor((end - start) / 120));
	return { start, end, step };
}

export function metricSeries(query: URLSearchParams, cpu: number, memMb: number) {
	const { start, end, step } = metricsWindow(query);
	return {
		start,
		end,
		step,
		data: {
			cpu: series(start, end, step, cpu, cpu * 0.35),
			mem: series(start, end, step, memMb, memMb * 0.06),
			rx: series(start, end, step, 42, 30),
			tx: series(start, end, step, 18, 12)
		}
	};
}

function databaseSeries(query: URLSearchParams, db: MockDatabase) {
	const base = metricSeries(query, 38, Math.round(db.memoryRequestBytes / MIB / 2));
	const { start, end, step } = base;
	const used = db.storageUsedBytes / MIB;
	const capacity = parseGi(db.storageSize) / MIB;
	const flat = (y: number) => series(start, end, step, y, 0);
	return {
		...base,
		data: {
			...base.data,
			connections: series(start, end, step, 9, 4).map((p) => ({ ...p, y: Math.round(p.y) })),
			tps: series(start, end, step, 140, 90),
			cacheHit: series(start, end, step, 98.6, 1.1).map((p) => ({ ...p, y: Math.min(100, p.y) })),
			lag:
				db.instances > 1
					? series(start, end, step, 0.04, 0.03).map((p) => ({ ...p, y: Math.max(0, p.y) }))
					: [],
			size: series(start, end, step, used * 0.98, used * 0.02),
			deadlocks: flat(0),
			disk: series(start, end, step, used * 1.12, used * 0.03),
			diskCapacity: flat(capacity)
		}
	};
}

export function databaseRoutes(r: Router, { store }: MockContext) {
	const find = (id: string) => store.database(id);
	const changed = (db: MockDatabase) => {
		store.touch(db);
		store.emit('database.changed', db.projectId, db.id);
	};

	r.get('/databases', () => store.state.databases.map((db) => databaseSummary(store, db)));
	r.get('/databases/:id', ({ params, query }) => {
		const db = find(params.id);
		return db
			? databaseDetail(store, db, query.get('fast') === '1')
			: notFound('Database not found');
	});
	r.get('/databases/:id/live', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		return { liveStatus: liveStatus(db), pods: pods(db), status: db.status };
	});
	r.get('/databases/:id/provisioning', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		const done = db.status === 'ready';
		const steps = [
			['cluster', 'Create cluster', 'Asking CloudNativePG for a new cluster'],
			['storage', 'Provision storage', `Binding a ${db.storageSize} volume`],
			['primary', 'Start primary', 'Initialising the database'],
			['ready', 'Ready', 'Accepting connections']
		].map(([id, label, description], i) => ({
			id,
			label,
			description,
			status: done ? 'done' : i < 2 ? 'done' : i === 2 ? 'running' : 'pending'
		}));
		return {
			databaseId: db.id,
			status: db.status,
			mode: db.mode,
			done,
			failed: false,
			phase: done ? 'Cluster in healthy state' : 'Setting up primary',
			hasImport: false,
			importStatus: null,
			importLogs: null,
			steps,
			events: [
				{
					type: 'Normal',
					reason: 'CreatingInstance',
					message: `Primary instance is being created: ${db.name}-cluster-1`,
					kind: 'Cluster',
					name: `${db.name}-cluster`,
					count: 1,
					lastTimestamp: db.createdAt
				}
			],
			pod: { name: `${db.name}-cluster-1`, phase: done ? 'Running' : 'Pending', waiting: null },
			importPod: null
		};
	});
	r.get('/databases/:id/anomalies', () => ({ anomalies: [] }));
	r.get('/databases/:id/backups', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		return db.backups.map((b) => ({
			id: b.id,
			label: b.method === 'manual' ? 'Manual backup' : 'Scheduled backup',
			backupName: b.name,
			type: 'full',
			status: b.status,
			sizeBytes: String(b.sizeBytes),
			errorMessage: null,
			createdAt: b.startedAt,
			completedAt: b.completedAt
		}));
	});
	r.post('/databases/:id/backups', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		const startedAt = new Date().toISOString();
		const b = {
			id: freshId(),
			name: `${db.name}-manual-${Date.now().toString(36)}`,
			status: 'running' as 'running' | 'completed',
			method: 'manual' as const,
			sizeBytes: 0,
			startedAt,
			completedAt: null as string | null
		};
		db.backups.unshift(b);
		changed(db);
		setTimeout(() => {
			b.status = 'completed';
			b.sizeBytes = Math.round(db.storageUsedBytes * 0.3);
			b.completedAt = new Date().toISOString();
			changed(db);
		}, 5_000);
		return { ok: true, id: b.id };
	});
	r.get('/databases/:id/backup-schedule', ({ params }) => {
		const db = find(params.id);
		return db
			? { cron: db.backupSchedule.enabled ? db.backupSchedule.schedule : null }
			: notFound();
	});
	r.put('/databases/:id/backup-schedule', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound();
		db.backupSchedule = {
			...db.backupSchedule,
			enabled: true,
			schedule: String(body?.cron ?? '0 3 * * *')
		};
		changed(db);
		return { cron: db.backupSchedule.schedule };
	});
	r.delete('/databases/:id/backup-schedule', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		db.backupSchedule.enabled = false;
		changed(db);
		return { ok: true };
	});
	r.get('/databases/:id/extensions', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		const available = [
			['pg_stat_statements', 'track planning and execution statistics of all SQL statements'],
			['pgcrypto', 'cryptographic functions'],
			['uuid-ossp', 'generate universally unique identifiers (UUIDs)'],
			['pg_trgm', 'text similarity measurement and index searching based on trigrams'],
			['vector', 'vector data type and ivfflat and hnsw access methods'],
			['postgis', 'PostGIS geometry and geography spatial types and functions'],
			['hstore', 'data type for storing sets of (key, value) pairs']
		];
		return {
			extensions: available.map(([name, comment]) => ({
				name,
				installed: db.extensions.includes(name),
				version: db.extensions.includes(name) ? '1.10' : undefined,
				defaultVersion: '1.10',
				comment
			})),
			sharedPreloadLibraries: db.extensions.includes('pg_stat_statements')
				? ['pg_stat_statements']
				: []
		};
	});
	r.post('/databases/:id/extensions', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound();
		if (body?.name && !db.extensions.includes(body.name)) db.extensions.push(body.name);
		changed(db);
		return { success: true, preloadAdded: Boolean(body?.addToPreload), output: 'CREATE EXTENSION' };
	});
	r.delete('/databases/:id/extensions/:name', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		db.extensions = db.extensions.filter((e) => e !== params.name);
		changed(db);
		return { success: true, output: 'DROP EXTENSION' };
	});
	r.get('/databases/:id/settings', () => ({
		parameters: {
			max_connections: '100',
			shared_buffers: '128MB',
			work_mem: '4MB',
			statement_timeout: '0',
			log_min_duration_statement: '250'
		},
		sharedPreloadLibraries: ['pg_stat_statements'],
		backupCompression: 'gzip',
		advisories: [],
		drift: {}
	}));
	r.patch('/databases/:id/settings', ({ body }) => ({
		parameters: body?.parameters ?? {},
		advisories: []
	}));
	r.get('/databases/:id/query-stats', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		const qs = [
			['SELECT "public"."User".* FROM "public"."User" WHERE "id" = $1', 48213, 0.42],
			['SELECT * FROM "Project" WHERE "organizationId" = $1 ORDER BY "updatedAt" DESC', 9120, 3.1],
			['UPDATE "Session" SET "lastActiveAt" = $1 WHERE "id" = $2', 31770, 0.88],
			['INSERT INTO "AuditLog" ("id","action","createdAt") VALUES ($1,$2,$3)', 4402, 1.6],
			['SELECT count(*) FROM "Vote" WHERE "projectId" = $1', 1208, 41.2]
		] as const;
		return {
			installed: db.extensions.includes('pg_stat_statements'),
			queries: qs.map(([query, calls, mean], i) => ({
				id: sha(`${db.id}:${i}`).slice(0, 16),
				query,
				calls,
				total_ms: +(calls * mean).toFixed(1),
				mean_ms: mean,
				max_ms: +(mean * 14).toFixed(1),
				rows: calls,
				blks_hit: calls * 12,
				blks_read: Math.round(calls * 0.3)
			}))
		};
	});
	r.post('/databases/:id/query-stats/reset', () => ({ ok: true }));
	r.get('/databases/:id/metrics', ({ params, query }) => {
		const db = find(params.id);
		if (!db) return notFound();
		return databaseSeries(query, db);
	});
	r.get('/databases/:id/killed-containers', () => []);
	r.get('/databases/:id/killed-containers/:entryId/logs', () => ({ logs: '' }));
	r.get('/databases/:id/connection', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound();
		const detail = databaseDetail(store, db);
		return {
			host: detail.host,
			port: detail.port,
			user: db.username,
			password: db.password,
			database: db.dbName,
			connectionString: detail.connectionString.replace('****', db.password),
			publicConnectionString: null
		};
	});
	r.delete('/databases/:id/public', () => ({ ok: true }));

	for (const action of ['stop', 'start', 'restart'] as const) {
		r.post(`/databases/:id/${action}`, ({ params }) => {
			const db = find(params.id);
			if (!db) return notFound();
			if (action === 'stop') db.status = 'stopped';
			else {
				db.status = 'restarting';
				setTimeout(() => {
					db.status = 'ready';
					changed(db);
				}, 4_000);
			}
			changed(db);
			return { ok: true };
		});
	}
	r.patch('/databases/:id/resources', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound();
		if (body?.cpuRequestMilli != null) db.cpuRequestMilli = Number(body.cpuRequestMilli);
		if (body?.memoryRequestBytes != null) db.memoryRequestBytes = Number(body.memoryRequestBytes);
		changed(db);
		return { ok: true };
	});
	r.patch('/databases/:id/storage', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound();
		if (body?.storageSize) db.storageSize = String(body.storageSize);
		changed(db);
		return { storageSize: db.storageSize };
	});
	r.patch('/databases/:id/replicas', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound();
		db.instances = Math.max(1, Math.min(5, Number(body?.replicas ?? db.instances)));
		changed(db);
		return { ok: true };
	});
	r.patch('/databases/:id/name', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound();
		if (body?.name) db.name = String(body.name);
		changed(db);
		return { name: db.name };
	});
	r.post('/databases/:id/public', () =>
		reply(400, { message: 'Public access needs a real cluster, it is off in mock mode' })
	);
	r.delete('/databases/:id', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		return trashDatabase(store, db);
	});

	r.get('/databases/limits', () => ({ maxReplicas: 5 }));
	const create = ({ params, body }: { params: Record<string, string>; body: any }) => {
		const p = store.project(params.pid ?? body?.projectId ?? '');
		if (!p) return reply(400, { message: 'projectId is required' });
		const name = slugify(String(body?.name ?? 'postgres')) || 'postgres';
		const env =
			store.state.environments.find((e) => e.id === body?.environmentId) ??
			store.state.environments.find((e) => e.projectId === p.id && e.isDefault);
		const now = new Date().toISOString();
		const db: MockDatabase = {
			id: freshId(),
			projectId: p.id,
			environmentId: env?.id ?? '',
			name,
			dbName: body?.dbName ?? 'app',
			engine: 'postgres',
			version: String(body?.pgMajor ?? body?.version ?? '16'),
			status: 'provisioning',
			mode: 'cnpg',
			instances: Number(body?.replicas ?? 1),
			storageSize: body?.storageSize ?? '5Gi',
			storageUsedBytes: 48 * MIB,
			cpuRequestMilli: Number(body?.cpuRequestMilli ?? 250),
			memoryRequestBytes: Number(body?.memoryRequestBytes ?? 512 * MIB),
			username: 'app',
			password: sha(`${now}:pw`).slice(0, 24),
			extensions: [],
			backups: [],
			backupSchedule: { enabled: true, schedule: '0 3 * * *', retentionDays: 7 },
			creatorId: store.state.meId,
			createdAt: now,
			updatedAt: now
		};
		store.provisionDatabase(db);
		return databaseDetail(store, db, true);
	};
	r.post('/databases', create);
	r.post('/projects/:pid/databases', create);
}
