import { freshId, sha, slugify, uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import type { Store } from '../store.ts';
import type { MockDatabase } from '../types.ts';

type Phase =
	| 'queued'
	| 'provisioning'
	| 'recovering'
	| 'verifying'
	| 'cleaning_up'
	| 'cutting_over'
	| 'finalizing'
	| 'rehearsal_provisioning'
	| 'rehearsal_cloning'
	| 'rehearsal_upgrading'
	| 'upgrading'
	| 'upgrade_waiting'
	| 'upgrade_finishing'
	| 'done';

type Target =
	| { type: 'latest' }
	| { type: 'now' }
	| { type: 'time'; time: string }
	| { type: 'checkpoint'; checkpointId: string }
	| { type: 'backup'; backupId: string }
	| { type: 'major'; major: number; image?: string };

export interface MockOp {
	id: string;
	databaseId: string | null;
	kind: 'restore' | 'fork' | 'undelete' | 'drill' | 'upgrade';
	request?: Record<string, unknown>;
	mode: 'in_place' | 'fork' | null;
	target: Target | null;
	source: Record<string, unknown>;
	targetNamespace: string | null;
	targetClusterName: string | null;
	targetDatabaseId: string | null;
	plan: [Phase, number][];
	startMs: number;
	endedAt?: number;
	failAt?: Phase;
	error: string | null;
	result: Record<string, unknown>;
	settled: boolean;
	onDone?: (op: MockOp) => void;
}

interface MockCheckpoint {
	id: string;
	databaseId: string;
	groupId: string | null;
	label: string | null;
	kind: 'manual' | 'pre_deploy' | 'pre_op' | 'ddl';
	status: 'pending' | 'durable' | 'failed' | 'expired';
	restorePointName: string;
	lsn: string | null;
	walFile: string | null;
	detail: string | null;
	deploymentId: string | null;
	releaseId: string | null;
	createdAt: string;
	durableAt: string | null;
	expiresAt: string | null;
	error: string | null;
	hidden?: boolean;
}

interface Rec {
	deletionProtection: boolean;
	ddlCheckpoints: boolean;
	restoreTests: boolean;
	pooler: {
		enabled: boolean;
		instances: number;
		poolMode: 'transaction' | 'session';
		defaultPoolSize: number;
		maxClientConn: number;
	};
	checkpoints: MockCheckpoint[];
	forkedFromId: string | null;
	forkedAt: string | null;
	replication: 'async' | 'preferred' | 'required';
	users: { name: string; access: 'read' | 'write' }[];
}

interface TrashEntry {
	id: string;
	db: MockDatabase;
	reason: 'user' | 'environment' | 'project';
	recoverable: boolean;
	deletedAt: string;
	deletedBy: string | null;
	purgeAfter: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MIB = 1024 ** 2;
const DURABLE_AFTER = 8_000;
const RETENTION = 30 * DAY;

const recs = new Map<string, Rec>();
export const ops: MockOp[] = [];
const trash: TrashEntry[] = [];

const iso = (ms: number) => new Date(ms).toISOString();

const admin = {
	ddlCheckpoints: { dbValue: true, envOverride: null as boolean | null },
	restoreDrills: { dbValue: false, envOverride: true as boolean | null },
	pluginMigration: { dbValue: true, envOverride: null as boolean | null },
	poolerByDefault: { dbValue: true, envOverride: null as boolean | null }
};
const migration = {
	halted: 'billing-cluster: WAL archive check failed' as string | null,
	migrated: 12,
	remaining: 28
};

function lsn(seed: string) {
	const h = sha(seed);
	return `${parseInt(h.slice(0, 2), 16).toString(16).toUpperCase()}/${h.slice(2, 10).toUpperCase()}`;
}

function walFile(seed: string) {
	return `0000000100000000${sha(seed).slice(0, 8).toUpperCase()}`;
}

function checkpoint(
	db: MockDatabase,
	kind: MockCheckpoint['kind'],
	createdMs: number,
	extra: Partial<MockCheckpoint> = {}
): MockCheckpoint {
	const id = extra.id ?? freshId();
	const status = extra.status ?? (Date.now() - createdMs > DURABLE_AFTER ? 'durable' : 'pending');
	return {
		id,
		databaseId: db.id,
		groupId: null,
		label: null,
		kind,
		status,
		restorePointName: `orchard_${kind}_${id.slice(0, 8)}`,
		lsn: lsn(id),
		walFile: walFile(id),
		detail: null,
		deploymentId: null,
		releaseId: null,
		createdAt: iso(createdMs),
		durableAt: status === 'durable' ? iso(createdMs + 6_000) : null,
		expiresAt: iso(createdMs + RETENTION),
		error: null,
		...extra
	};
}

export function namespaceOf(store: Store, db: MockDatabase) {
	const env = store.state.environments.find((e) => e.id === db.environmentId);
	const p = store.project(db.projectId);
	const o = p ? store.org(p.organizationId) : undefined;
	return env?.namespace ?? `${o?.slug ?? 'org'}-${p?.slug ?? 'project'}`;
}

export function sourceOf(store: Store, db: MockDatabase) {
	return {
		name: db.name,
		namespace: namespaceOf(store, db),
		clusterName: `${db.name}-cluster`,
		projectId: db.projectId,
		environmentId: db.environmentId,
		pgMajor: Number(db.version)
	};
}

function rec(db: MockDatabase): Rec {
	let r = recs.get(db.id);
	if (!r) {
		r = {
			deletionProtection: false,
			ddlCheckpoints: true,
			restoreTests: false,
			pooler: {
				enabled: false,
				instances: 1,
				poolMode: 'transaction',
				defaultPoolSize: 20,
				maxClientConn: 200
			},
			checkpoints: [],
			forkedFromId: null,
			forkedAt: null,
			replication: 'async',
			users: []
		};
		recs.set(db.id, r);
	}
	return r;
}

function settleCheckpoints(r: Rec) {
	const now = Date.now();
	for (const c of r.checkpoints) {
		const created = Date.parse(c.createdAt);
		if (c.status === 'pending' && now - created > DURABLE_AFTER) {
			c.status = 'durable';
			c.durableAt = iso(now);
		}
		if (c.status === 'durable' && c.expiresAt && Date.parse(c.expiresAt) < now)
			c.status = 'expired';
	}
}

const PROGRESS: Partial<Record<Phase, string>> = {
	provisioning: 'Waiting for a 10 GB volume',
	recovering: 'Replayed 412 MB of WAL, 1.2 GB to go',
	verifying: 'Checked 9 of 14 tables',
	cleaning_up: 'Deleting the throwaway copy',
	cutting_over: 'Moving apps to the restored copy',
	rehearsal_cloning: 'Copying 2.1 GB to a rehearsal cluster',
	rehearsal_upgrading: 'Running pg_upgrade on the copy',
	upgrade_waiting: 'Postgres is offline while pg_upgrade runs',
	upgrade_finishing: 'Running ANALYZE and a fresh base backup',
	finalizing: 'Creating the app user'
};

export function opView(op: MockOp) {
	const now = Date.now();
	const total = op.plan.reduce((a, [, d]) => a + d, 0);
	const naturalEnd = op.startMs + total;
	const ended = op.endedAt ?? (now >= naturalEnd ? naturalEnd : null);
	let phase: Phase = 'done';
	let status: 'pending' | 'running' | 'succeeded' | 'failed' = 'succeeded';
	if (ended == null) {
		let t = op.startMs;
		for (const [p, d] of op.plan) {
			if (now < t + d) {
				phase = p;
				break;
			}
			t += d;
		}
		status = phase === 'queued' ? 'pending' : 'running';
	} else if (op.error) {
		status = 'failed';
		phase = op.failAt ?? op.plan.at(-1)?.[0] ?? 'done';
	}
	const queued = op.plan[0]?.[0] === 'queued' ? op.plan[0][1] : 0;
	const progress = status === 'running' ? PROGRESS[phase] : undefined;
	return {
		id: op.id,
		databaseId: op.databaseId,
		kind: op.kind,
		mode: op.mode,
		status,
		phase,
		target: op.target,
		source: op.source,
		request: op.request ?? null,
		targetNamespace: op.targetNamespace,
		targetClusterName: op.targetClusterName,
		targetDatabaseId: op.targetDatabaseId,
		result: { ...op.result, ...(progress ? { progress } : {}) },
		error: status === 'failed' ? op.error : null,
		createdAt: iso(op.startMs),
		startedAt: now >= op.startMs + queued ? iso(op.startMs + queued) : null,
		finishedAt: ended != null ? iso(ended) : null
	};
}

function tick(store: Store) {
	for (const op of ops) {
		if (op.settled) continue;
		const v = opView(op);
		if (v.status !== 'succeeded' && v.status !== 'failed') continue;
		op.settled = true;
		if (v.status === 'succeeded') op.onDone?.(op);
		const db = op.databaseId ? store.database(op.databaseId) : undefined;
		if (db) store.emit('database.changed', db.projectId, db.id);
		const target = op.targetDatabaseId ? store.database(op.targetDatabaseId) : undefined;
		if (target) store.emit('database.changed', target.projectId, target.id);
	}
	for (const r of recs.values()) settleCheckpoints(r);
}

function readyAfter(store: Store, dbId: string) {
	return () => {
		const db = store.database(dbId);
		if (!db) return;
		db.status = 'ready';
		store.touch(db);
	};
}

function cloneDatabase(
	store: Store,
	from: MockDatabase,
	name: string,
	environmentId: string | null,
	status = 'restoring',
	projectId = from.projectId
): MockDatabase {
	const now = new Date().toISOString();
	const id = freshId();
	const otherProject = projectId !== from.projectId;
	const targetEnv =
		environmentId ||
		(otherProject
			? (store.state.environments.find((e) => e.projectId === projectId && e.isDefault)?.id ??
				from.environmentId)
			: from.environmentId);
	const db: MockDatabase = {
		...from,
		id,
		name,
		projectId,
		environmentId: targetEnv,
		status,
		password: sha(`${id}:pw`).slice(0, 24),
		extensions: [...from.extensions],
		backups: [],
		backupSchedule: { ...from.backupSchedule },
		creatorId: store.state.meId,
		createdAt: now,
		updatedAt: now
	};
	store.state.databases.push(db);
	store.emit('database.changed', db.projectId, db.id);
	return db;
}

function parseTarget(body: any, fallback: 'latest' | 'now'): Target {
	if (body?.checkpointId) return { type: 'checkpoint', checkpointId: String(body.checkpointId) };
	if (body?.backupId) return { type: 'backup', backupId: String(body.backupId) };
	const at = body?.at;
	if (at === 'now') return { type: 'now' };
	if (at === 'latest') return { type: 'latest' };
	if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return { type: 'time', time: at };
	return { type: fallback };
}

function startFork(store: Store, db: MockDatabase, body: any, target: Target) {
	const name =
		slugify(String(body?.name ?? '')) ||
		`${db.name}-copy${store.state.databases.some((d) => d.name === `${db.name}-copy`) ? `-${Date.now().toString(36).slice(-3)}` : ''}`;
	const copy = cloneDatabase(
		store,
		db,
		name,
		body?.environmentId ?? null,
		'restoring',
		body?.projectId || db.projectId
	);
	const r = rec(copy);
	r.forkedFromId = db.id;
	r.forkedAt = new Date().toISOString();
	const op: MockOp = {
		id: freshId(),
		databaseId: db.id,
		kind: 'fork',
		mode: 'fork',
		target,
		source: sourceOf(store, db),
		targetNamespace: namespaceOf(store, copy),
		targetClusterName: `${copy.name}-cluster`,
		targetDatabaseId: copy.id,
		plan: [
			['queued', 2_000],
			['provisioning', 8_000],
			['recovering', 14_000],
			['finalizing', 4_000]
		],
		startMs: Date.now(),
		error: null,
		result: { recoveredFrom: target.type === 'now' ? 'live' : target },
		settled: false,
		onDone: (o) => {
			readyAfter(store, copy.id)();
			o.result = {
				...o.result,
				recoveredAt: new Date().toISOString(),
				sizeBytes: db.storageUsedBytes
			};
		}
	};
	ops.unshift(op);
	return op;
}

function startInPlace(store: Store, db: MockDatabase, target: Target) {
	const r = rec(db);
	r.checkpoints.unshift(checkpoint(db, 'pre_op', Date.now(), { label: 'Before restore' }));
	const op: MockOp = {
		id: freshId(),
		databaseId: db.id,
		kind: 'restore',
		mode: 'in_place',
		target,
		source: sourceOf(store, db),
		targetNamespace: namespaceOf(store, db),
		targetClusterName: `${db.name}-cluster-${Date.now().toString(36).slice(-4)}`,
		targetDatabaseId: db.id,
		plan: [
			['queued', 2_000],
			['provisioning', 8_000],
			['recovering', 14_000],
			['cutting_over', 5_000]
		],
		startMs: Date.now(),
		error: null,
		result: { recoveredFrom: target },
		settled: false,
		onDone: (o) => {
			const done = Date.now();
			o.result = {
				...o.result,
				recoveredAt: iso(done),
				retired: {
					namespace: namespaceOf(store, db),
					clusterName: `${db.name}-cluster`,
					retireAfter: iso(done + DAY),
					deleted: false
				}
			};
		}
	};
	ops.unshift(op);
	return op;
}

function startDrill(store: Store, db: MockDatabase) {
	const op: MockOp = {
		id: freshId(),
		databaseId: db.id,
		kind: 'drill',
		mode: null,
		target: { type: 'latest' },
		source: sourceOf(store, db),
		targetNamespace: namespaceOf(store, db),
		targetClusterName: `${db.name}-drill-${Date.now().toString(36).slice(-4)}`,
		targetDatabaseId: null,
		plan: [
			['queued', 2_000],
			['provisioning', 7_000],
			['recovering', 12_000],
			['verifying', 5_000],
			['cleaning_up', 3_000]
		],
		startMs: Date.now(),
		error: null,
		result: {},
		settled: false,
		onDone: (o) => {
			o.result = {
				recoveredAt: new Date().toISOString(),
				recoveryMs: 19_000,
				sizeBytes: db.storageUsedBytes,
				verdict: { passed: true, tablesChecked: 14, missingTables: [], rowDrift: [], reasons: [] }
			};
		}
	};
	ops.unshift(op);
	return op;
}

function trashEntryView(t: TrashEntry, store: Store) {
	const p = store.project(t.db.projectId);
	return {
		id: t.id,
		projectId: t.db.projectId,
		organizationId: p?.organizationId ?? '',
		environmentId: t.db.environmentId,
		name: t.db.name,
		pgMajor: Number(t.db.version),
		reason: t.reason,
		recoverableUntil: t.recoverable ? t.purgeAfter : null,
		deletedAt: t.deletedAt,
		deletedBy: t.deletedBy,
		purgeAfter: t.purgeAfter
	};
}

export function recoveryFields(db: MockDatabase) {
	if (db.engine !== 'postgres') return {};
	const r = rec(db);
	return {
		deletionProtection: r.deletionProtection,
		ddlCheckpoints: r.ddlCheckpoints,
		restoreTests: r.restoreTests,
		poolerEnabled: r.pooler.enabled,
		poolerConfig: r.pooler.enabled
			? {
					instances: r.pooler.instances,
					poolMode: r.pooler.poolMode,
					defaultPoolSize: r.pooler.defaultPoolSize,
					maxClientConn: r.pooler.maxClientConn
				}
			: null,
		backupMethod: 'plugin',
		backupServerName: `${db.name}-cluster`,
		forkedFromId: r.forkedFromId,
		forkedAt: r.forkedAt
	};
}

export function trashDatabase(store: Store, db: MockDatabase) {
	if (db.engine === 'postgres' && rec(db).deletionProtection) {
		return reply(400, {
			statusCode: 400,
			message: 'Deletion protection is on. Turn it off in Settings, Protection first.'
		});
	}
	const now = Date.now();
	const recoverable = db.backups.some((b) => b.status === 'completed');
	if (db.engine === 'postgres') {
		trash.unshift({
			id: freshId(),
			db: { ...db },
			reason: 'user',
			recoverable,
			deletedAt: iso(now),
			deletedBy: store.state.meId,
			purgeAfter: iso(now + RETENTION)
		});
	}
	store.removeDatabase(db.id);
	return {
		success: true,
		message: `${db.name} was deleted`,
		recoverableUntil: recoverable ? iso(now + RETENTION) : null
	};
}

function seedRecovery(store: Store) {
	const now = Date.now();
	const postgres = store.state.databases.filter(
		(d) => d.engine === 'postgres' && d.mode === 'cnpg'
	);
	const main = postgres[0];
	for (const db of postgres) {
		const r = rec(db);
		r.checkpoints.push(
			checkpoint(db, 'pre_deploy', now - 26 * HOUR, {
				id: uid(`cp:${db.id}:deploy`),
				label: 'Before deploy of web',
				deploymentId: uid(`dep:${db.projectId}:web`)
			}),
			checkpoint(db, 'manual', now - 4 * DAY, {
				id: uid(`cp:${db.id}:manual`),
				label: 'Before the schema cleanup'
			})
		);
		ops.push({
			id: uid(`op:${db.id}:drill`),
			databaseId: db.id,
			kind: 'drill',
			mode: null,
			target: { type: 'latest' },
			source: sourceOf(store, db),
			targetNamespace: namespaceOf(store, db),
			targetClusterName: `${db.name}-drill-a1`,
			targetDatabaseId: null,
			plan: [
				['queued', 2_000],
				['provisioning', 18_000],
				['recovering', 47_000],
				['verifying', 6_000],
				['cleaning_up', 4_000]
			],
			startMs: now - 2 * DAY - 3 * HOUR,
			error: null,
			result: {
				recoveredAt: iso(now - 2 * DAY - 3 * HOUR + 67_000),
				recoveryMs: 47_000,
				sizeBytes: db.storageUsedBytes,
				verdict: { passed: true, tablesChecked: 14, missingTables: [], rowDrift: [], reasons: [] }
			},
			settled: true
		});
	}
	if (!main) return;
	const r = rec(main);
	r.deletionProtection = true;
	r.restoreTests = true;
	r.replication = 'preferred';
	r.users = [
		{ name: 'metabase', access: 'read' },
		{ name: 'etl_worker', access: 'write' }
	];
	r.pooler = {
		enabled: true,
		instances: 1,
		poolMode: 'transaction',
		defaultPoolSize: 25,
		maxClientConn: 400
	};
	r.checkpoints.unshift(
		checkpoint(main, 'manual', now - 40 * MIN, {
			id: uid(`cp:${main.id}:recent`),
			label: 'Before backfilling votes'
		}),
		checkpoint(main, 'ddl', now - 3 * HOUR, {
			id: uid(`cp:${main.id}:ddl`),
			detail: 'public.users (by u_app)'
		}),
		checkpoint(main, 'pre_op', now - 2 * HOUR - 5 * MIN, {
			id: uid(`cp:${main.id}:preop`),
			label: 'Before restore'
		})
	);
	r.checkpoints.push(
		checkpoint(main, 'manual', now - 6 * DAY, {
			id: uid(`cp:${main.id}:failed`),
			label: 'Before the import',
			status: 'failed',
			durableAt: null,
			error: 'WAL archiving was failing, so the restore point never reached storage'
		}),
		checkpoint(main, 'pre_deploy', now - 34 * DAY, {
			id: uid(`cp:${main.id}:expired`),
			label: 'Before deploy of web',
			status: 'expired',
			expiresAt: iso(now - 4 * DAY)
		})
	);
	ops.push({
		id: uid(`op:${main.id}:restore`),
		databaseId: main.id,
		kind: 'restore',
		mode: 'in_place',
		target: { type: 'time', time: iso(now - 3 * HOUR - 4 * MIN) },
		source: sourceOf(store, main),
		targetNamespace: namespaceOf(store, main),
		targetClusterName: `${main.name}-cluster-r7k2`,
		targetDatabaseId: main.id,
		plan: [
			['queued', 3_000],
			['provisioning', 20_000],
			['recovering', 64_000],
			['cutting_over', 8_000]
		],
		startMs: now - 2 * HOUR - 4 * MIN,
		error: null,
		result: {
			recoveredFrom: { type: 'time', time: iso(now - 3 * HOUR - 4 * MIN) },
			recoveredAt: iso(now - 2 * HOUR - 3 * MIN),
			retired: {
				namespace: namespaceOf(store, main),
				clusterName: `${main.name}-cluster`,
				retireAfter: iso(now - 2 * HOUR + DAY),
				deleted: false
			}
		},
		settled: true
	});
	ops.push({
		id: uid(`op:${main.id}:drill-failed`),
		databaseId: main.id,
		kind: 'drill',
		mode: null,
		target: { type: 'latest' },
		source: sourceOf(store, main),
		targetNamespace: namespaceOf(store, main),
		targetClusterName: `${main.name}-drill-z9`,
		targetDatabaseId: null,
		plan: [
			['queued', 2_000],
			['provisioning', 18_000],
			['recovering', 52_000],
			['verifying', 6_000]
		],
		startMs: now - 9 * DAY,
		failAt: 'verifying',
		error: 'The restored copy is missing public.votes',
		result: {
			recoveryMs: 52_000,
			verdict: {
				passed: false,
				tablesChecked: 13,
				missingTables: ['public.votes'],
				rowDrift: [],
				reasons: ['The restored copy is missing public.votes']
			}
		},
		settled: true
	});
	const env = store.state.environments.find(
		(e) => e.projectId === main.projectId && e.id !== main.environmentId
	);
	const preview = cloneDatabase(store, main, `${main.name}-preview`, env?.id ?? null);
	const pr = rec(preview);
	pr.forkedFromId = main.id;
	pr.forkedAt = iso(now - 45_000);
	ops.unshift({
		id: uid(`op:${main.id}:fork`),
		databaseId: main.id,
		kind: 'fork',
		mode: 'fork',
		target: { type: 'latest' },
		source: sourceOf(store, main),
		targetNamespace: namespaceOf(store, preview),
		targetClusterName: `${preview.name}-cluster`,
		targetDatabaseId: preview.id,
		plan: [
			['queued', 3_000],
			['provisioning', 30_000],
			['recovering', 240_000],
			['finalizing', 30_000]
		],
		startMs: now - 45_000,
		error: null,
		result: { recoveredFrom: { type: 'latest' } },
		settled: false,
		onDone: (o) => {
			readyAfter(store, preview.id)();
			o.result = {
				...o.result,
				recoveredAt: new Date().toISOString(),
				sizeBytes: main.storageUsedBytes
			};
		}
	});

	const gone = (name: string, days: number, recoverable: boolean, reason: TrashEntry['reason']) => {
		const id = uid(`trash:${main.projectId}:${name}`);
		trash.push({
			id,
			db: {
				...main,
				id: uid(`db:${main.projectId}:${name}`),
				name,
				storageUsedBytes: 220 * MIB,
				backups: []
			},
			reason,
			recoverable,
			deletedAt: iso(now - days * DAY),
			deletedBy: store.state.meId,
			purgeAfter: iso(now - days * DAY + RETENTION)
		});
	};
	gone('staging-snapshot', 3, true, 'user');
	gone('scratch', 11, false, 'user');
}

export function recoveryRoutes(r: Router, { store }: MockContext) {
	seedRecovery(store);
	const timer = setInterval(() => tick(store), 1_000);
	timer.unref?.();

	const find = (id: string) => store.database(id);
	const opById = (id: string) => ops.find((o) => o.id === id);
	const checkpointById = (id: string) => {
		for (const [dbId, rr] of recs) {
			const c = rr.checkpoints.find((x) => x.id === id);
			if (c) return { c, db: store.database(dbId) };
		}
		return null;
	};
	const visible = (db: MockDatabase) =>
		rec(db)
			.checkpoints.filter((c) => !c.hidden)
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	const opsOf = (db: MockDatabase) =>
		ops
			.filter((o) => o.databaseId === db.id || o.targetDatabaseId === db.id)
			.map(opView)
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

	r.get('/databases/:id/recovery', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		tick(store);
		const all = opsOf(db);
		const drills = all.filter((o) => o.kind === 'drill' && o.databaseId === db.id);
		const done = db.backups.filter((b) => b.status === 'completed');
		const earliest = done.at(-1)?.startedAt ?? null;
		return {
			earliest,
			latest: earliest ? new Date().toISOString() : null,
			archiving: { ok: true, message: null },
			backups: done.map((b) => ({
				id: b.id,
				label: b.method === 'manual' ? 'Manual backup' : 'Scheduled backup',
				type: b.method,
				completedAt: b.completedAt,
				barmanId: b.completedAt
					? b.completedAt
							.replace(/[-:]/g, '')
							.replace(/\.\d+Z$/, '')
							.slice(0, 15)
					: null,
				startedAt: b.startedAt
			})),
			checkpoints: visible(db),
			lastRestoreTest:
				drills.find((d) => d.status === 'succeeded' || d.status === 'failed') ?? null,
			restoreTests: drills,
			activeOperations: all.filter((o) => o.status === 'pending' || o.status === 'running'),
			protection: {
				deletionProtection: rec(db).deletionProtection,
				ddlCheckpoints: rec(db).ddlCheckpoints,
				restoreTests: rec(db).restoreTests
			}
		};
	});

	r.get('/databases/:id/operations', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		tick(store);
		return opsOf(db);
	});

	r.get('/database-operations/:opId', async ({ params, query }) => {
		const op = opById(params.opId);
		if (!op) return notFound('Operation not found');
		const before = opView(op);
		if (query.get('wait') === '1' && (before.status === 'pending' || before.status === 'running')) {
			const until = Date.now() + 4_000;
			while (Date.now() < until) {
				await new Promise((res) => setTimeout(res, 250));
				const now = opView(op);
				if (now.phase !== before.phase || now.status !== before.status) break;
			}
		}
		tick(store);
		return opView(op);
	});

	r.post('/database-operations/:opId/cancel', ({ params }) => {
		const op = opById(params.opId);
		if (!op) return notFound('Operation not found');
		const v = opView(op);
		if (v.status === 'succeeded' || v.status === 'failed')
			return reply(400, { message: 'This operation already finished' });
		op.endedAt = Date.now();
		op.failAt = v.phase;
		op.error = 'Canceled';
		op.settled = true;
		if (op.kind !== 'restore' && op.targetDatabaseId && op.targetDatabaseId !== op.databaseId) {
			store.removeDatabase(op.targetDatabaseId);
		}
		const db = op.databaseId ? find(op.databaseId) : undefined;
		if (db) store.emit('database.changed', db.projectId, db.id);
		return opView(op);
	});

	r.post('/database-operations/:opId/undo', ({ params }) => {
		const op = opById(params.opId);
		if (!op) return notFound('Operation not found');
		const retired = op.result.retired as { retireAfter: string; deleted?: boolean } | undefined;
		if (!retired || retired.deleted || Date.parse(retired.retireAfter) < Date.now())
			return reply(400, { message: 'The copy from before this restore is gone' });
		op.result = { ...op.result, retired: { ...retired, deleted: true }, undoneAt: iso(Date.now()) };
		const db = op.databaseId ? find(op.databaseId) : undefined;
		if (db) store.emit('database.changed', db.projectId, db.id);
		return opView(op);
	});

	r.post('/databases/:id/restore', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const target = parseTarget(body, 'latest');
		const op =
			body?.mode === 'fork' ? startFork(store, db, body, target) : startInPlace(store, db, target);
		store.emit('database.changed', db.projectId, db.id);
		return opView(op);
	});

	r.post('/databases/:id/fork', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const targetProject = body?.projectId ? store.project(String(body.projectId)) : null;
		const source = store.project(db.projectId);
		if (
			body?.projectId &&
			(!targetProject || targetProject.organizationId !== source?.organizationId)
		)
			return notFound('Project not found');
		const crossProject = !!targetProject && targetProject.id !== db.projectId;
		const target = parseTarget(body, crossProject ? 'latest' : 'now');
		if (crossProject && target.type === 'now') {
			return reply(400, {
				message:
					'A copy into another project starts from a backup, because projects cannot reach each other. Pick the latest backup or a time.'
			});
		}
		const op = startFork(store, db, body, target);
		store.emit('database.changed', db.projectId, db.id);
		return opView(op);
	});

	r.get('/databases/:id/checkpoints', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		tick(store);
		return visible(db);
	});

	r.post('/databases/:id/checkpoints', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : null;
		const c = checkpoint(db, 'manual', Date.now(), { label });
		rec(db).checkpoints.unshift(c);
		store.emit('database.changed', db.projectId, db.id);
		return c;
	});

	r.post('/checkpoints', ({ body }) => {
		const ids: string[] = Array.isArray(body?.databaseIds) ? body.databaseIds : [];
		const dbs = store.state.databases.filter((d) => {
			if (d.engine !== 'postgres' || d.mode !== 'cnpg' || d.status !== 'ready') return false;
			if (ids.length) return ids.includes(d.id);
			if (body?.environmentId) return d.environmentId === body.environmentId;
			if (body?.projectId) return d.projectId === body.projectId;
			return false;
		});
		const groupId = freshId();
		const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : null;
		const made = dbs.map((db) => {
			const c = checkpoint(db, 'manual', Date.now(), { label, groupId });
			rec(db).checkpoints.unshift(c);
			store.emit('database.changed', db.projectId, db.id);
			return c;
		});
		return { groupId, checkpoints: made };
	});

	r.get('/checkpoints/groups/:groupId', ({ params }) =>
		[...recs.values()].flatMap((rr) => rr.checkpoints.filter((c) => c.groupId === params.groupId))
	);

	r.post('/checkpoints/groups/:groupId/restore', ({ params, body }) => {
		const out = [];
		for (const [dbId, rr] of recs) {
			const c = rr.checkpoints.find((x) => x.groupId === params.groupId);
			const db = store.database(dbId);
			if (!c || !db) continue;
			const target: Target = { type: 'checkpoint', checkpointId: c.id };
			out.push(
				opView(
					body?.mode === 'fork' ? startFork(store, db, {}, target) : startInPlace(store, db, target)
				)
			);
		}
		return out;
	});

	r.post('/checkpoints/:id/restore', ({ params, body }) => {
		const found = checkpointById(params.id);
		if (!found?.db) return notFound('Checkpoint not found');
		if (found.c.status !== 'durable')
			return reply(400, { message: 'This checkpoint cannot be restored' });
		const target: Target = { type: 'checkpoint', checkpointId: found.c.id };
		const op =
			body?.mode === 'fork'
				? startFork(store, found.db, body, target)
				: startInPlace(store, found.db, target);
		return opView(op);
	});

	r.delete('/checkpoints/:id', ({ params }) => {
		const found = checkpointById(params.id);
		if (!found) return notFound('Checkpoint not found');
		found.c.hidden = true;
		if (found.db) store.emit('database.changed', found.db.projectId, found.db.id);
		return found.c;
	});

	r.get('/databases/:id/restore-tests', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		tick(store);
		return opsOf(db).filter((o) => o.kind === 'drill');
	});

	r.post('/databases/:id/restore-tests', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const running = ops.find((o) => o.kind === 'drill' && o.databaseId === db.id && !o.settled);
		if (running) return reply(409, { message: 'A restore test is already running' });
		const op = startDrill(store, db);
		store.emit('database.changed', db.projectId, db.id);
		return opView(op);
	});

	r.patch('/databases/:id/protection', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const rr = rec(db);
		for (const key of ['deletionProtection', 'ddlCheckpoints', 'restoreTests'] as const) {
			if (typeof body?.[key] === 'boolean') rr[key] = body[key];
		}
		store.touch(db);
		store.emit('database.changed', db.projectId, db.id);
		return {
			id: db.id,
			deletionProtection: rr.deletionProtection,
			ddlCheckpoints: rr.ddlCheckpoints,
			restoreTests: rr.restoreTests
		};
	});

	const poolerView = (db: MockDatabase) => {
		const p = rec(db).pooler;
		return {
			enabled: p.enabled,
			config: {
				instances: p.instances,
				poolMode: p.poolMode,
				defaultPoolSize: p.defaultPoolSize,
				maxClientConn: p.maxClientConn
			},
			host: p.enabled ? `${db.name}-pooler-rw.${namespaceOf(store, db)}.svc.cluster.local` : null,
			port: p.enabled ? 5432 : null,
			ready: p.enabled,
			phase: p.enabled ? 'Ready' : null
		};
	};

	r.get('/databases/:id/pooler', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		return poolerView(db);
	});

	r.put('/databases/:id/pooler', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const p = rec(db).pooler;
		if (typeof body?.enabled === 'boolean') p.enabled = body.enabled;
		if (body?.poolMode === 'transaction' || body?.poolMode === 'session')
			p.poolMode = body.poolMode;
		if (body?.instances != null) p.instances = Math.max(1, Math.min(3, Number(body.instances)));
		if (body?.defaultPoolSize != null)
			p.defaultPoolSize = Math.max(1, Math.min(100, Number(body.defaultPoolSize)));
		if (body?.maxClientConn != null)
			p.maxClientConn = Math.max(10, Math.min(5000, Number(body.maxClientConn)));
		store.emit('database.changed', db.projectId, db.id);
		return poolerView(db);
	});

	r.get('/projects/:id/deleted-databases', ({ params }) => {
		const p = store.project(params.id);
		if (!p) return notFound('Project not found');
		return trash.filter((t) => t.db.projectId === p.id).map((t) => trashEntryView(t, store));
	});

	r.post('/deleted-databases/:id/restore', ({ params, body }) => {
		const i = trash.findIndex((t) => t.id === params.id);
		if (i === -1) return notFound('Deleted database not found');
		const t = trash[i];
		if (!t.recoverable)
			return reply(400, {
				message: 'This database was never backed up, so it cannot be brought back'
			});
		trash.splice(i, 1);
		const name = slugify(String(body?.name ?? '')) || t.db.name;
		const db: MockDatabase = {
			...t.db,
			id: freshId(),
			name,
			environmentId: body?.environmentId ?? t.db.environmentId,
			status: 'restoring',
			updatedAt: new Date().toISOString()
		};
		store.state.databases.push(db);
		const op: MockOp = {
			id: freshId(),
			databaseId: null,
			kind: 'undelete',
			mode: null,
			target: { type: 'latest' },
			source: { ...sourceOf(store, t.db), trashId: t.id },
			targetNamespace: namespaceOf(store, db),
			targetClusterName: `${db.name}-cluster`,
			targetDatabaseId: db.id,
			plan: [
				['queued', 2_000],
				['provisioning', 6_000],
				['recovering', 10_000],
				['finalizing', 3_000]
			],
			startMs: Date.now(),
			error: null,
			result: {},
			settled: false,
			onDone: () => readyAfter(store, db.id)()
		};
		ops.unshift(op);
		store.emit('database.changed', db.projectId, db.id);
		return opView(op);
	});

	const replicationView = (db: MockDatabase) => {
		const mode = rec(db).replication;
		return { mode, instances: db.instances, syncStandbys: mode === 'async' ? 0 : 1 };
	};
	r.get('/databases/:id/replication', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		return replicationView(db);
	});
	r.patch('/databases/:id/replication', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const mode = body?.mode;
		if (mode !== 'async' && mode !== 'preferred' && mode !== 'required')
			return reply(400, { message: 'mode must be async, preferred or required' });
		if (mode !== 'async' && db.instances < 2)
			return reply(400, { message: 'Add a standby first: this needs at least 2 instances' });
		rec(db).replication = mode;
		store.emit('database.changed', db.projectId, db.id);
		return replicationView(db);
	});

	r.get('/databases/:id/users', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		return rec(db).users.map((u) => ({ ...u, present: true }));
	});
	r.post('/databases/:id/users', ({ params, body }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const name = String(body?.name ?? '');
		if (!/^[a-z][a-z0-9_]{1,40}$/.test(name))
			return reply(400, {
				message: 'Use lowercase letters, digits and underscores, starting with a letter'
			});
		const rr = rec(db);
		if (name === db.username || rr.users.some((u) => u.name === name))
			return reply(409, { message: `${name} already exists` });
		const access = body?.access === 'read' ? 'read' : 'write';
		rr.users.push({ name, access });
		const password = sha(`${db.id}:${name}:${Date.now()}`).slice(0, 24);
		const host = `${db.name}-cluster-rw.${namespaceOf(store, db)}.svc.cluster.local`;
		return {
			name,
			access,
			password,
			connectionString: `postgresql://${name}:${password}@${host}:5432/${db.dbName}`
		};
	});
	r.delete('/databases/:id/users/:name', ({ params }) => {
		const db = find(params.id);
		if (!db) return notFound('Database not found');
		const rr = rec(db);
		rr.users = rr.users.filter((u) => u.name !== params.name);
		return { name: params.name, present: false };
	});

	const adminView = () =>
		Object.fromEntries(
			Object.entries(admin).map(([k, v]) => [
				k,
				{ enabled: v.envOverride ?? v.dbValue, dbValue: v.dbValue, envOverride: v.envOverride }
			])
		);

	r.get('/admin/instance-settings/databases', () => adminView());
	r.patch('/admin/instance-settings/databases', ({ body }) => {
		const key = body?.toggle as keyof typeof admin;
		const entry = admin[key];
		if (!entry) return reply(400, { message: 'Unknown toggle' });
		if (entry.envOverride !== null)
			return reply(400, { message: 'This setting is pinned by an environment variable' });
		entry.dbValue = Boolean(body?.enabled);
		return adminView();
	});

	const migrationView = () => ({
		enabled: admin.pluginMigration.envOverride ?? admin.pluginMigration.dbValue,
		pluginInstalled: true,
		halted: migration.halted,
		migrated: migration.migrated,
		remaining: migration.remaining
	});
	r.get('/admin/databases/plugin-migration', () => migrationView());
	r.post('/admin/databases/plugin-migration/resume', () => {
		migration.halted = null;
		migration.migrated += 1;
		migration.remaining = Math.max(0, migration.remaining - 1);
		return migrationView();
	});
}
