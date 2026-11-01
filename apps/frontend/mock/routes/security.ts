import { createHash } from 'node:crypto';
import { sha } from '../ids.ts';
import type { MockContext } from '../plugin.ts';
import { notFound, reply, type Router } from '../router.ts';
import type { MockDeployment } from '../types.ts';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

type Scenario =
	| 'vulnerable'
	| 'clean'
	| 'scanning'
	| 'not_scanned'
	| 'failed'
	| 'unreachable'
	| 'unauthorized'
	| 'not_configured'
	| 'not_found'
	| 'list_error';

const SCENARIOS: Scenario[] = [
	'vulnerable',
	'clean',
	'scanning',
	'not_scanned',
	'failed',
	'unreachable',
	'unauthorized',
	'not_configured',
	'not_found',
	'list_error'
];

const SCAN_MS = 8_000;
const FINISHED_AGO_MS = 2 * 60 * 60_000;

const FINDINGS: {
	id: string;
	package: string;
	version: string;
	fixVersion: string | null;
	severity: Severity;
	cvss: number | null;
	description: string;
}[] = [
	{
		id: 'CVE-2023-45853',
		package: 'zlib1g',
		version: '1:1.2.13.dfsg-1',
		fixVersion: null,
		severity: 'critical',
		cvss: 9.8,
		description:
			'MiniZip in zlib through 1.3 has an integer overflow and resultant heap-based buffer overflow in zipOpenNewFileInZip4_64 via a long filename, comment, or extra field.'
	},
	{
		id: 'CVE-2024-45337',
		package: 'golang.org/x/crypto',
		version: 'v0.21.0',
		fixVersion: '0.31.0',
		severity: 'critical',
		cvss: 9.1,
		description:
			'Applications and libraries which misuse the ServerConfig.PublicKeyCallback callback may be susceptible to an authorization bypass.'
	},
	{
		id: 'CVE-2023-38545',
		package: 'libcurl4',
		version: '7.88.1-10',
		fixVersion: '7.88.1-10+deb12u4',
		severity: 'critical',
		cvss: 9.8,
		description:
			'A heap based buffer overflow in the SOCKS5 proxy handshake when curl is asked to pass the host name to the proxy and the name is longer than 255 bytes.'
	},
	{
		id: 'CVE-2023-4863',
		package: 'libwebp7',
		version: '1.2.4-0.2',
		fixVersion: '1.2.4-0.2+deb12u1',
		severity: 'high',
		cvss: 8.8,
		description:
			'Heap buffer overflow in libwebp allowed a remote attacker to perform an out of bounds memory write via a crafted HTML page.'
	},
	{
		id: 'CVE-2024-6387',
		package: 'openssh-client',
		version: '1:9.2p1-2+deb12u2',
		fixVersion: '1:9.2p1-2+deb12u3',
		severity: 'high',
		cvss: 8.1,
		description:
			'A signal handler race condition in sshd lets an unauthenticated attacker run code as root on glibc-based Linux systems.'
	},
	{
		id: 'CVE-2024-21538',
		package: 'cross-spawn',
		version: '7.0.3',
		fixVersion: '7.0.5',
		severity: 'high',
		cvss: 7.5,
		description:
			'Regular expression denial of service caused by improper input sanitization; a large crafted string makes the CPU usage spike.'
	},
	{
		id: 'CVE-2024-4068',
		package: 'braces',
		version: '3.0.2',
		fixVersion: '3.0.3',
		severity: 'high',
		cvss: 7.5,
		description:
			'Imbalanced braces in input make the parser loop without ever returning, exhausting memory.'
	},
	{
		id: 'CVE-2024-52798',
		package: 'path-to-regexp',
		version: '0.1.10',
		fixVersion: '0.1.12',
		severity: 'high',
		cvss: 7.5,
		description:
			'A bad regular expression is generated any time two parameters sit within a single segment, separated by something that is not a period.'
	},
	{
		id: 'CVE-2023-52425',
		package: 'libexpat1',
		version: '2.5.0-1',
		fixVersion: null,
		severity: 'high',
		cvss: 7.5,
		description:
			'libexpat through 2.5.0 allows a denial of service because many full reparsings are required for a large token.'
	},
	{
		id: 'CVE-2024-28849',
		package: 'follow-redirects',
		version: '1.15.5',
		fixVersion: '1.15.6',
		severity: 'medium',
		cvss: 6.5,
		description:
			'The Proxy-Authorization header is kept across hosts when redirecting, leaking proxy credentials to the redirect target.'
	},
	{
		id: 'CVE-2024-2398',
		package: 'libcurl4',
		version: '7.88.1-10',
		fixVersion: '7.88.1-10+deb12u6',
		severity: 'medium',
		cvss: 6.5,
		description:
			'When an HTTP/2 server push is aborted after too many headers, curl leaks the memory it had allocated for them.'
	},
	{
		id: 'CVE-2023-50495',
		package: 'libncursesw6',
		version: '6.4-4',
		fixVersion: null,
		severity: 'medium',
		cvss: 6.5,
		description:
			'NCurse v6.4-20230418 was discovered to contain a segmentation fault via _nc_wrap_entry().'
	},
	{
		id: 'CVE-2024-55565',
		package: 'nanoid',
		version: '3.3.7',
		fixVersion: '3.3.8',
		severity: 'medium',
		cvss: 4.3,
		description: 'nanoid mishandles non-integer values, which can produce predictable IDs.'
	},
	{
		id: 'CVE-2011-3374',
		package: 'apt',
		version: '2.6.1',
		fixVersion: null,
		severity: 'low',
		cvss: 3.7,
		description:
			'apt-key in apt does not correctly validate gpg keys with the master keyring, leading to a potential man-in-the-middle attack.'
	},
	{
		id: 'CVE-2022-0563',
		package: 'libblkid1',
		version: '2.38.1-5+b1',
		fixVersion: null,
		severity: 'low',
		cvss: 5.5,
		description:
			'A flaw in util-linux chfn and chsh when compiled with Readline lets an unprivileged user read root-owned files.'
	},
	{
		id: 'TEMP-0841856-B18BAF',
		package: 'bash',
		version: '5.2.15-2+b2',
		fixVersion: null,
		severity: 'low',
		cvss: null,
		description: 'Privilege escalation possible to other user than root.'
	}
];

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

const VULNERABILITIES = FINDINGS.map((f) => ({
	...f,
	url: f.id.startsWith('CVE-')
		? `https://nvd.nist.gov/vuln/detail/${f.id}`
		: `https://security-tracker.debian.org/tracker/${f.id}`
})).sort(
	(a, b) =>
		RANK[a.severity] - RANK[b.severity] ||
		Number(!a.fixVersion) - Number(!b.fixVersion) ||
		(b.cvss ?? -1) - (a.cvss ?? -1) ||
		a.id.localeCompare(b.id)
);

function counts(list: typeof VULNERABILITIES) {
	const out = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0, fixable: 0 };
	for (const v of list) {
		out[v.severity] += 1;
		out.total += 1;
		if (v.fixVersion) out.fixable += 1;
	}
	return out;
}

const ZERO = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0, fixable: 0 };

const MUTABLE_TAGS = new Set([
	'latest',
	'main',
	'master',
	'stable',
	'edge',
	'dev',
	'develop',
	'nightly',
	'prod',
	'production',
	'release'
]);

function isMutableTag(image: string) {
	const raw = image.trim();
	if (!raw || raw.includes('@sha256:')) return false;
	const slash = raw.indexOf('/');
	let rest = raw;
	if (slash > 0) {
		const host = raw.slice(0, slash);
		if (host.includes('.') || host.includes(':') || host === 'localhost')
			rest = raw.slice(slash + 1);
	}
	const colon = rest.lastIndexOf(':');
	const tag = colon === -1 ? 'latest' : rest.slice(colon + 1);
	return MUTABLE_TAGS.has(tag.toLowerCase()) || /^v?\d+(\.\d+)?$/.test(tag);
}

const SECRET_WORDS = new Set([
	'SECRET',
	'SECRETS',
	'TOKEN',
	'TOKENS',
	'PASSWORD',
	'PASSWD',
	'PASSPHRASE',
	'PWD',
	'KEY',
	'APIKEY',
	'SECRETKEY',
	'ACCESSKEY',
	'PRIVATEKEY',
	'AUTHTOKEN',
	'PRIVATE',
	'CREDENTIAL',
	'CREDENTIALS'
]);
const PUBLIC_WORDS = new Set(['PUBLIC', 'PUBLISHABLE', 'PUB', 'VITE']);
const DESCRIPTORS = new Set([
	'URL',
	'URI',
	'HOST',
	'PORT',
	'PATH',
	'FILE',
	'DIR',
	'ENDPOINT',
	'ID',
	'NAME',
	'USER',
	'USERNAME',
	'TTL',
	'EXPIRY',
	'EXPIRES',
	'LENGTH',
	'LEN',
	'HEADER',
	'ISSUER',
	'ALGORITHM',
	'ALG',
	'TYPE',
	'ENABLED',
	'REGION',
	'PREFIX',
	'COUNT',
	'AGE',
	'TIMEOUT'
]);

function looksSecret(key: string) {
	const tokens = key
		.toUpperCase()
		.split(/[^A-Z0-9]+/)
		.filter(Boolean);
	if (tokens.length === 0 || tokens.some((t) => PUBLIC_WORDS.has(t))) return false;
	if (DESCRIPTORS.has(tokens[tokens.length - 1])) return false;
	return tokens.some((t) => SECRET_WORDS.has(t));
}

function inert(value: string) {
	const v = value.trim();
	return !v || v.includes('${{') || /^(true|false|yes|no|on|off|none|null|\d+)$/i.test(v);
}

function posture(d: MockDeployment, external: boolean) {
	const out: { kind: string; severity: string; subjects: string[] }[] = [];
	const plain = d.envVars
		.filter((e) => !e.secret && looksSecret(e.key) && !inert(String(e.value ?? '')))
		.map((e) => e.key)
		.sort();
	if (plain.length > 0) out.push({ kind: 'plain-secret', severity: 'high', subjects: plain });
	if (external && d.image && isMutableTag(d.image))
		out.push({ kind: 'mutable-tag', severity: 'low', subjects: [d.image] });
	return out;
}

function digestOf(d: MockDeployment) {
	return `sha256:${createHash('sha256').update(`${d.id}:${d.image}`).digest('hex')}`;
}

type Sec = { scenario: Scenario; scanStartedAt: number | null; finishedAt: number };

type Provider = 'off' | 'harbor' | 'trivy';

const PROVIDERS: Provider[] = ['off', 'harbor', 'trivy'];

export function securityRoutes(r: Router, { store }: MockContext) {
	const state = new Map<string, Sec>();
	let provider: Provider = 'trivy';

	const scanning = () => ({
		value: provider,
		dbValue: provider,
		defaultValue: 'trivy',
		envOverride: null,
		options: PROVIDERS.map((value) => ({ value, available: true, reason: null }))
	});

	r.get('/admin/instance-settings/image-scanning', () => scanning());

	r.patch('/admin/instance-settings/image-scanning', ({ body }) => {
		if (!PROVIDERS.includes(body?.value))
			return reply(400, { message: 'value must be one of off, harbor, trivy', statusCode: 400 });
		provider = body.value;
		return scanning();
	});

	const defaultScenario = (d: MockDeployment): Scenario => {
		const n = parseInt(sha(`${d.name}:security`).slice(0, 2), 16) % 3;
		return n === 1 ? 'clean' : 'vulnerable';
	};

	const stateOf = (d: MockDeployment): Sec => {
		let s = state.get(d.id);
		if (!s) {
			s = {
				scenario: defaultScenario(d),
				scanStartedAt: null,
				finishedAt: Date.now() - FINISHED_AGO_MS
			};
			state.set(d.id, s);
		}
		if (s.scanStartedAt && Date.now() - s.scanStartedAt >= SCAN_MS) {
			s.finishedAt = s.scanStartedAt + SCAN_MS;
			s.scanStartedAt = null;
			if (!['vulnerable', 'clean'].includes(s.scenario)) s.scenario = 'vulnerable';
		}
		return s;
	};

	const report = (d: MockDeployment) => {
		const external = !d.githubRepo;
		const build = store.buildsOf(d.id)[0];
		const tag = external ? null : (d.image.split(':').pop() ?? null);
		const s = stateOf(d);
		const inProgress = s.scanStartedAt !== null || s.scenario === 'scanning';
		const finishedAt = new Date(s.finishedAt).toISOString();
		const startedAt = new Date(s.finishedAt - 41_000).toISOString();
		const scanner = { name: 'Trivy', version: provider === 'trivy' ? '0.76.1' : 'v0.56.2' };
		const base = {
			image: {
				ref: d.image || null,
				source: !d.image ? 'none' : external ? 'external' : 'orchard',
				tag,
				digest: external || !d.image ? null : digestOf(d),
				pushedAt: external ? null : (build?.buildCompletedAt ?? null),
				commitSha: external ? null : (build?.commitSha ?? null),
				commitMessage: external ? null : (build?.commitMessage ?? null),
				builtAt: external ? null : (build?.buildCompletedAt ?? null)
			},
			truncated: 0,
			posture: posture(d, external),
			checkedAt: new Date().toISOString()
		};
		const scan = (over: Record<string, unknown>, canRescan = true): Record<string, unknown> => ({
			state: 'not_scanned',
			reason: null,
			severity: null,
			counts: ZERO,
			progress: null,
			startedAt: null,
			finishedAt: null,
			scanner: null,
			canRescan,
			provider,
			error: null,
			...over
		});

		if (!d.image)
			return {
				...base,
				scan: scan({ state: 'unsupported', reason: 'no_image' }, false),
				vulnerabilities: null
			};
		if (provider === 'off')
			return { ...base, scan: scan({ state: 'off' }, false), vulnerabilities: null };
		if (external && provider === 'harbor')
			return {
				...base,
				scan: scan({ state: 'unsupported', reason: 'external_image' }, false),
				vulnerabilities: null
			};
		if (inProgress) {
			const elapsed = s.scanStartedAt ? Date.now() - s.scanStartedAt : SCAN_MS * 0.4;
			return {
				...base,
				scan: scan(
					{
						state: 'scanning',
						progress:
							provider === 'trivy' ? null : Math.min(99, Math.round((elapsed / SCAN_MS) * 100)),
						startedAt: new Date(s.scanStartedAt ?? Date.now()).toISOString(),
						scanner
					},
					false
				),
				vulnerabilities: null
			};
		}
		switch (s.scenario) {
			case 'clean':
				return {
					...base,
					scan: scan({ state: 'clean', severity: 'none', startedAt, finishedAt, scanner }),
					vulnerabilities: []
				};
			case 'not_scanned':
				return { ...base, scan: scan({}), vulnerabilities: null };
			case 'failed':
				return {
					...base,
					scan: scan({
						state: 'failed',
						startedAt,
						finishedAt,
						scanner,
						error:
							provider === 'trivy'
								? 'unable to find the image: GET https://ghcr.io/v2/acme/web/manifests/latest: UNAUTHORIZED'
								: null
					}),
					vulnerabilities: null
				};
			case 'unreachable':
			case 'unauthorized':
			case 'not_configured':
			case 'not_found':
				return {
					...base,
					image: { ...base.image, digest: null, pushedAt: null },
					scan: scan(
						{ state: 'error', reason: s.scenario },
						s.scenario === 'unreachable' || s.scenario === 'unauthorized'
					),
					vulnerabilities: null
				};
			default: {
				const c = counts(VULNERABILITIES);
				return {
					...base,
					scan: scan({
						state: 'vulnerable',
						severity: 'critical',
						counts: c,
						startedAt,
						finishedAt,
						scanner
					}),
					vulnerabilities: s.scenario === 'list_error' ? null : VULNERABILITIES
				};
			}
		}
	};

	r.get('/deployments/:id/security/attacks', ({ params, query }) => {
		const d = store.deployment(params.id);
		if (!d) return notFound('Deployment not found');
		if (!d.host) return reply(503, { message: 'This app has no domain, so there are no requests' });
		const end = Number(query.get('end')) || Date.now();
		const start = Number(query.get('start')) || end - 86_400_000;
		const step = Math.max(60_000, Math.round((end - start) / 60));
		const series: ({ t: number } & Record<string, number>)[] = [];
		for (let t = start - (start % step); t < end; t += step) {
			const i = Math.floor(t / step);
			series.push({
				t,
				scanner: i % 7 === 2 ? 40 + (i % 13) : i % 3 === 0 ? 3 : 0,
				injection: i % 11 === 5 ? 12 : 0,
				'auth-bruteforce': i % 19 === 9 ? 64 : 0,
				flood: i % 29 === 14 ? 900 : 0
			});
		}
		const sum = (k: string) => series.reduce((n, b) => n + (b[k] ?? 0), 0);
		return {
			recorded: true,
			byKind: {
				scanner: sum('scanner'),
				injection: sum('injection'),
				'auth-bruteforce': sum('auth-bruteforce'),
				flood: sum('flood')
			},
			series,
			topSources: [
				{ ip: '45.148.10.0/24', count: 2700, kinds: ['flood'] },
				{ ip: '185.220.101.0/24', count: 412, kinds: ['scanner', 'injection'] },
				{ ip: '193.32.162.0/24', count: 192, kinds: ['auth-bruteforce'] },
				{ ip: '94.102.61.0/24', count: 88, kinds: ['scanner'] }
			],
			samples: []
		};
	});
	r.get('/deployments/:id/security', ({ params }) => {
		const d = store.deployment(params.id);
		return d ? report(d) : notFound('Deployment not found');
	});

	r.post('/deployments/:id/security/scan', ({ params }) => {
		const d = store.deployment(params.id);
		if (!d) return notFound('Deployment not found');
		if (provider === 'off')
			return reply(400, {
				message:
					'Image scanning is off for this instance. A superadmin can turn it on in Admin, Instance.',
				statusCode: 400
			});
		if (!d.image)
			return reply(400, { message: 'This app has no image to scan yet', statusCode: 400 });
		if (!d.githubRepo && provider === 'harbor')
			return reply(400, { message: 'Harbor can only scan images Orchard builds', statusCode: 400 });
		const s = stateOf(d);
		if (s.scenario === 'not_configured')
			return reply(400, {
				message: 'Image scanning is not configured on this instance',
				statusCode: 400
			});
		if (s.scenario === 'unreachable')
			return reply(503, { message: 'The image scanner is unavailable', statusCode: 503 });
		if (!s.scanStartedAt) s.scanStartedAt = Date.now();
		if (s.scenario !== 'clean') s.scenario = 'vulnerable';
		return report(d);
	});

	r.get('/__mock/deployments/:id/security', () => ({ options: SCENARIOS }));

	r.post('/__mock/deployments/:id/security', ({ params, body }) => {
		const d = store.deployment(params.id);
		if (!d) return notFound('Deployment not found');
		const scenario = SCENARIOS.includes(body?.scenario)
			? (body.scenario as Scenario)
			: 'vulnerable';
		state.set(d.id, {
			scenario,
			scanStartedAt: null,
			finishedAt: Date.now() - FINISHED_AGO_MS
		});
		return { scenario };
	});
}
