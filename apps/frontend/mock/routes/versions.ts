import { freshId, uid } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import type { Store } from '../store.ts';
import type { MockDatabase } from '../types.ts';
import { namespaceOf, opView, ops, sourceOf, type MockOp } from './recovery.ts';

const DAY = 86_400_000;

const CATALOG = [
	{ major: 18, minor: '18.1', eolDate: '2030-11-14' },
	{ major: 17, minor: '17.11', eolDate: '2029-11-08' },
	{ major: 16, minor: '16.11', eolDate: '2028-11-09' },
	{ major: 15, minor: '15.15', eolDate: '2027-11-11' },
	{ major: 14, minor: '14.20', eolDate: '2026-11-12' },
	{ major: 13, minor: '13.23', eolDate: '2025-11-13' }
];

const DEFAULT_MAJOR = 17;

const running = new Map<string, string>();

const image = (minor: string) => `ghcr.io/cloudnative-pg/postgresql:${minor}-system-trixie`;

export const orgAutoUpdate = new Map<string, boolean>();

function autoUpdateOf(store: Store, db: MockDatabase) {
	const orgId = store.project(db.projectId)?.organizationId;
	const organization = !!(orgId && orgAutoUpdate.get(orgId));
	return { enabled: organization, organization, instance: true };
}

function offered(c: (typeof CATALOG)[number]) {
	return {
		major: c.major,
		image: image(c.minor),
		minor: Number(c.minor.split('.')[1]),
		supported: supported(c.major),
		current: true,
		eolDate: c.eolDate
	};
}

function latestMinor(major: number) {
	return CATALOG.find((c) => c.major === major)?.minor ?? `${major}.0`;
}

function supported(major: number) {
	const c = CATALOG.find((x) => x.major === major);
	return c ? Date.parse(c.eolDate) > Date.now() : null;
}

function runningOf(db: MockDatabase) {
	return running.get(db.id) ?? latestMinor(Number(db.version));
}

const CVES_17 = [
	{
		cve: 'CVE-2026-2003',
		description:
			'A crafted query against a table with row level security can read rows the policy should hide.',
		component: 'core server',
		score: 8.8,
		vector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H',
		fixedInVersion: '17.11'
	},
	{
		cve: 'CVE-2026-2004',
		description: 'pg_trgm can read past the end of a buffer on some multibyte inputs.',
		component: 'contrib module',
		score: 6.5,
		vector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H',
		fixedInVersion: '17.11'
	},
	{
		cve: 'CVE-2026-1102',
		description: 'pg_dump runs commands embedded in object names when restoring with psql.',
		component: 'client',
		score: 4.2,
		vector: 'CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:L',
		fixedInVersion: '17.10'
	}
];

const CVES_13 = [
	{
		cve: 'CVE-2026-2003',
		description:
			'A crafted query against a table with row level security can read rows the policy should hide.',
		component: 'core server',
		score: 8.8,
		vector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H',
		fixedInVersion: null
	},
	{
		cve: 'CVE-2025-8714',
		description:
			'A superuser of the origin server can run arbitrary code in psql during a restore.',
		component: 'client',
		score: 7.1,
		vector: 'CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:C/C:H/I:H/A:H',
		fixedInVersion: null
	}
];

function security(store: Store, db: MockDatabase) {
	const major = Number(db.version);
	const run = runningOf(db);
	const latest = latestMinor(major);
	const eol = CATALOG.find((c) => c.major === major)?.eolDate ?? null;
	const isSupported = supported(major);
	const vulns = (major === 13 ? CVES_13 : run === '17.9' ? CVES_17 : []).map((v) => ({
		...v,
		url: `https://www.postgresql.org/support/security/${v.cve}/`
	}));
	const behind = run !== latest;
	const upgrades = CATALOG.filter((c) => c.major > major)
		.sort((a, b) => b.major - a.major)
		.map(offered);
	const autoUpdate = autoUpdateOf(store, db);
	const action = !isSupported ? 'major_upgrade' : behind && vulns.length ? 'minor_update' : 'none';
	return {
		running: run,
		major,
		minor: Number(run.split('.')[1] ?? 0),
		latestMinor: latest,
		supported: isSupported,
		eolDate: eol,
		endOfLifeSoon: !!eol && isSupported === true && Date.parse(eol) - Date.now() < 365 * DAY,
		vulnerabilities: vulns,
		highestScore: vulns.length ? Math.max(...vulns.map((v) => v.score)) : null,
		action,
		image: image(run),
		minorUpdate:
			behind && isSupported ? { to: latest, automatic: autoUpdate.enabled, blocked: null } : null,
		autoUpdate,
		upgrades,
		advisoriesFetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString()
	};
}

function seed(store: Store) {
	const postgres = store.state.databases.filter(
		(d) => d.engine === 'postgres' && d.mode === 'cnpg'
	);
	const main = postgres[0];
	if (main) {
		main.version = '17';
		running.set(main.id, '17.9');
		const now = Date.now();
		ops.push({
			id: uid(`op:${main.id}:upgrade-old`),
			databaseId: main.id,
			kind: 'upgrade',
			mode: null,
			target: { type: 'major', major: 18, image: image('18.1') },
			request: { rehearse: true },
			source: sourceOf(store, main),
			targetNamespace: namespaceOf(store, main),
			targetClusterName: `${main.name}-cluster`,
			targetDatabaseId: main.id,
			plan: [
				['queued', 2_000],
				['rehearsal_provisioning', 20_000],
				['rehearsal_cloning', 60_000],
				['rehearsal_upgrading', 80_000],
				['upgrading', 74_000]
			],
			startMs: now - 5 * DAY,
			failAt: 'upgrading',
			error: 'The extension pg_hint_plan has no build for Postgres 18, so the upgrade was put back',
			result: { rehearsal: { passed: true, upgradeMs: 74_000 } },
			settled: true
		});
	}
	const old = store.state.databases.find(
		(d) => d.engine === 'postgres' && store.project(d.projectId)?.slug === 'mercury'
	);
	if (old) {
		old.version = '13';
		running.set(old.id, '13.21');
	}
}

function startUpgrade(store: Store, db: MockDatabase, major: number, rehearse: boolean) {
	const before = db.status;
	db.status = 'upgrading';
	store.touch(db);
	const plan: [MockOp['plan'][number][0], number][] = [['queued', 2_000]];
	if (rehearse)
		plan.push(
			['rehearsal_provisioning', 8_000],
			['rehearsal_cloning', 12_000],
			['rehearsal_upgrading', 14_000]
		);
	plan.push(['upgrading', 10_000], ['upgrade_waiting', 10_000], ['upgrade_finishing', 12_000]);
	const op: MockOp = {
		id: freshId(),
		databaseId: db.id,
		kind: 'upgrade',
		mode: null,
		target: { type: 'major', major, image: image(latestMinor(major)) },
		request: { rehearse },
		source: sourceOf(store, db),
		targetNamespace: namespaceOf(store, db),
		targetClusterName: `${db.name}-cluster`,
		targetDatabaseId: db.id,
		plan,
		startMs: Date.now(),
		error: null,
		result: {},
		settled: false,
		onDone: (o) => {
			db.version = String(major);
			running.delete(db.id);
			db.status = before === 'upgrading' ? 'ready' : before;
			store.touch(db);
			o.result = {
				...o.result,
				...(rehearse ? { rehearsal: { passed: true, upgradeMs: 14_000 } } : {})
			};
		}
	};
	ops.unshift(op);
	store.emit('database.changed', db.projectId, db.id);
	return op;
}

export function versionRoutes(r: Router, { store }: MockContext) {
	seed(store);

	r.get('/database-versions', () => ({
		versions: CATALOG.map(offered),
		defaultMajor: DEFAULT_MAJOR,
		source: 'https://github.com/cloudnative-pg/postgres-containers',
		catalogDate: new Date(Date.now() - 2 * DAY).toISOString()
	}));

	r.get('/databases/:id/security', ({ params }) => {
		const db = store.database(params.id);
		if (!db) return notFound('Database not found');
		if (db.engine !== 'postgres') return reply(400, { message: 'Only Postgres databases' });
		return security(store, db);
	});

	r.get('/projects/:id/database-security', ({ params }) => {
		const dbs = store.state.databases.filter(
			(d) => d.projectId === params.id && d.engine === 'postgres' && d.mode === 'cnpg'
		);
		const orgId = store.project(params.id)?.organizationId;
		const organization = !!(orgId && orgAutoUpdate.get(orgId));
		return {
			autoUpdate: { enabled: organization, organization, instance: true },
			advisoriesFetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
			databases: dbs.map((db) => {
				const s = security(store, db);
				return {
					id: db.id,
					name: db.name,
					status: db.status,
					environmentId: db.environmentId ?? null,
					running: s.running,
					major: s.major,
					action: s.action,
					vulnerabilities: s.vulnerabilities.length,
					highestScore: s.highestScore,
					supported: s.supported,
					eolDate: s.eolDate,
					endOfLifeSoon: s.endOfLifeSoon,
					minorUpdate: s.minorUpdate,
					upgrades: s.upgrades
				};
			})
		};
	});

	r.post('/databases/:id/minor-update', ({ params }) => {
		const db = store.database(params.id);
		if (!db) return notFound('Database not found');
		const from = runningOf(db);
		const to = latestMinor(Number(db.version));
		if (from === to)
			return reply(400, {
				message: `The database already runs the newest Postgres ${db.version} image Orchard offers`
			});
		running.set(db.id, to);
		store.touch(db);
		store.emit('database.changed', db.projectId, db.id);
		return { from, to };
	});

	r.post('/databases/:id/upgrade', ({ params, body }) => {
		const db = store.database(params.id);
		if (!db) return notFound('Database not found');
		const major = Number(body?.major);
		if (!CATALOG.some((c) => c.major === major) || major <= Number(db.version))
			return reply(400, { message: `Postgres ${major} is not offered for this database` });
		if (ops.some((o) => o.databaseId === db.id && !o.settled && o.kind !== 'fork'))
			return reply(400, { message: 'Another restore or upgrade is running for this database' });
		return opView(startUpgrade(store, db, major, body?.rehearse !== false));
	});
}
