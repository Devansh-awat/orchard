import { freshId, sha, slugify, uid } from '../ids.ts';
import { BUCKET_MS, since, structured, tail } from '../logs.ts';
import type { MockContext } from '../plugin.ts';
import { STREAMING, notFound, reply, type Router } from '../router.ts';
import { openStream, writeMessage } from '../events.ts';
import { creator, deploymentSummary, ingress } from '../serialize.ts';
import type { Store } from '../store.ts';
import type { MockDeployment } from '../types.ts';
import { metricSeries, metricsWindow } from './databases.ts';

const MIB = 1024 ** 2;

function namespaceOf(store: Store, d: MockDeployment) {
	return store.state.environments.find((e) => e.id === d.environmentId)?.namespace ?? 'default';
}

export function podsOf(store: Store, d: MockDeployment) {
	if (d.stopped || d.replicas === 0) return [];
	const count = d.replicas;
	const status = d.crash
		? 'crashing'
		: d.status === 'restarting' || d.status === 'scaling'
			? 'starting'
			: 'ready';
	return Array.from({ length: count }, (_, i) => {
		const name = store.podName(d, i);
		const share = 1 / count;
		const jitter = 0.85 + (parseInt(sha(name).slice(0, 4), 16) % 30) / 100;
		return {
			id: uid(`pod:${name}`),
			name,
			status,
			ip: `10.42.${1 + i}.${(d.name.length * 13 + i * 7) % 250}`,
			podIp: `10.42.${1 + i}.${(d.name.length * 13 + i * 7) % 250}`,
			nodeName: ['house', 'barn', 'shed'][i % 3],
			restartCount: d.restarts,
			startTime: d.podStartedAt,
			createdAt: d.podStartedAt,
			cpuUsage: status === 'ready' ? Math.round(d.cpuUsageMilli * share * jitter) : 0,
			memoryUsage: Math.round(d.memoryUsageBytes * share * jitter),
			containers: [
				{
					name: d.name,
					image: d.image,
					ready: status === 'ready',
					restartCount: d.restarts,
					lastTermination: d.crash
						? {
								reason: d.crash.reason,
								exitCode: d.crash.exitCode,
								finishedAt: new Date(Date.now() - 40_000).toISOString()
							}
						: null
				}
			],
			events: d.crash
				? [
						{
							type: 'Warning',
							reason: 'BackOff',
							message: `Back-off restarting failed container ${d.name} in pod ${name}`,
							count: d.restarts,
							firstTimestamp: d.updatedAt,
							lastTimestamp: new Date(Date.now() - 30_000).toISOString()
						}
					]
				: [
						{
							type: 'Normal',
							reason: 'Started',
							message: `Started container ${d.name}`,
							count: 1,
							firstTimestamp: d.podStartedAt,
							lastTimestamp: d.podStartedAt
						}
					]
		};
	});
}

function warnings(store: Store, d: MockDeployment) {
	if (!d.crash) return [];
	return podsOf(store, d).map((p) => ({
		podName: p.name,
		message: `Back-off restarting failed container ${d.name}: ${d.crash!.reason} (exit ${d.crash!.exitCode})`,
		timestamp: new Date(Date.now() - 30_000).toISOString()
	}));
}

function service(store: Store, d: MockDeployment) {
	const ns = namespaceOf(store, d);
	const internalHost = `${d.name}.${ns}.svc.cluster.local`;
	return {
		id: uid(`svc:${d.id}`),
		deploymentId: d.id,
		name: d.name,
		type: d.host ? 'ingress' : 'internal',
		port: 80,
		targetPort: d.port,
		protocol: 'TCP',
		nodePort: null,
		externalIp: null,
		domain: d.host,
		internalHost,
		internalUrl: `http://${internalHost}`,
		internalUrls: [`http://${internalHost}`, `http://${d.name}`],
		ports: [
			{
				id: uid(`svcport:${d.id}`),
				serviceId: uid(`svc:${d.id}`),
				name: 'http',
				port: 80,
				targetPort: d.port,
				protocol: 'TCP',
				nodePort: null,
				publicEnabled: false,
				publicPort: null,
				internalUrl: `http://${internalHost}`
			}
		],
		createdAt: d.createdAt,
		updatedAt: d.updatedAt
	};
}

function imageHistory(store: Store, d: MockDeployment) {
	return store
		.buildsOf(d.id)
		.filter((b) => b.status !== 'building')
		.slice(0, 20)
		.map((b) => {
			const by = store.user(b.triggeredById);
			return {
				id: b.id,
				image: b.image,
				tag: b.image.split(':').at(-1),
				branch: b.branch,
				commitSha: b.commitSha,
				commitMessage: b.commitMessage,
				commitAuthorName: b.commitAuthorName,
				commitAuthorUsername: b.commitAuthorUsername,
				buildStartedAt: b.buildStartedAt,
				buildCompletedAt: b.buildCompletedAt,
				createdAt: b.createdAt,
				isActive: b.isActive,
				status: b.status,
				triggerType: b.triggerType === 'push' ? 'auto' : b.triggerType,
				triggeredBy: by
					? { id: by.id, username: by.username, firstName: by.firstName, lastName: by.lastName }
					: null
			};
		});
}

export function deploymentDetail(store: Store, d: MockDeployment) {
	const p = store.project(d.projectId)!;
	const env = store.state.environments.find((e) => e.id === d.environmentId);
	const pods = podsOf(store, d);
	const ready = pods.filter((x) => x.status === 'ready').length;
	const svc = service(store, d);
	return {
		...deploymentSummary(store, d),
		projectId: d.projectId,
		environmentId: d.environmentId,
		namespace: namespaceOf(store, d),
		buildStep: d.buildStep,
		buildStepTimestamps: d.buildStepTimestamps,
		buildLogs: d.buildLogs,
		buildError: d.buildError,
		availableReplicas: ready,
		specReplicas: d.stopped ? 0 : d.replicas,
		readyReplicas: ready,
		observedAt: new Date().toISOString(),
		meteredPods: pods.length,
		totalCpuUsage: pods.reduce((a, x) => a + (x.cpuUsage ?? 0), 0),
		totalMemoryUsage: pods.reduce((a, x) => a + (x.memoryUsage ?? 0), 0),
		cpuRequestMilli: d.cpuRequestMilli,
		memoryRequestBytes: String(d.memoryRequestBytes),
		githubRepo: d.githubRepo ? `https://github.com/${d.githubRepo}` : null,
		buildType: d.buildType,
		dockerfilePath: d.buildType === 'dockerfile' ? 'Dockerfile' : null,
		dockerfileTarget: null,
		buildFromRoot: false,
		buildWithDepot: false,
		persistentBuildCache: true,
		builderOverride: null,
		rootDirectory: null,
		framework: d.framework,
		installCommand: null,
		buildCommand: null,
		startCommand: null,
		outputDirectory: null,
		detectedConfig: d.framework
			? {
					framework: d.framework,
					providers: [d.framework === 'rails' ? 'ruby' : 'node'],
					isStatic: d.framework === 'vite',
					packageManager: d.framework === 'rails' ? null : 'pnpm',
					railpackVersion: '0.9.1'
				}
			: null,
		autoDeployEnabled: d.autoDeployEnabled,
		autoDeployBranch: d.githubBranch,
		autoDeployPaths: [],
		healthCheckEnabled: Boolean(d.host),
		healthCheckType: 'http',
		healthCheckPath: '/healthz',
		healthCheckPort: d.port,
		healthCheckCommand: null,
		livenessEnabled: true,
		readinessEnabled: true,
		startupEnabled: false,
		healthCheckInterval: 10,
		healthCheckTimeout: 3,
		healthCheckRetries: 3,
		startupFailureThreshold: 30,
		healthCheckOverride: false,
		dockerfileHealthCheck: null,
		deployStrategy: 'rollingUpdate',
		pdbMinAvailable: 0,
		imagePullPolicy: null,
		effectiveImagePullPolicy: 'IfNotPresent',
		tailscaleExposed: false,
		tailscaleHostname: null,
		createdBy: d.creatorId,
		applyError: null,
		queuedCommitSha: null,
		queuedCommitMessage: null,
		pendingPush: null,
		envConflicts: null,
		environment: env
			? { id: env.id, name: env.name, slug: env.slug, isDefault: env.isDefault }
			: null,
		project: { id: p.id, name: p.name, slug: p.slug, backgroundImage: p.backgroundImage },
		nodePoolId: null,
		pods,
		warnings: warnings(store, d),
		services: [svc],
		ingresses: ingress(d).map((i) => ({
			...i,
			routes: [{ path: '/', serviceName: svc.name, servicePort: 80 }],
			certificateStatus: 'ready',
			protectionBypassPaths: [],
			redirectTarget: null,
			redirectStatus: null,
			service: { id: svc.id, name: svc.name, port: 80 }
		})),
		volumes: d.volumes.map((v) => ({
			...v,
			deploymentId: d.id,
			pvcName: v.type === 'pvc' ? `${d.name}-${v.name}` : null,
			hostPath: null,
			observedCapacity: v.storageSize,
			phase: 'Bound',
			resizeState: null,
			resizeMessage: null,
			observedAt: new Date().toISOString()
		})),
		envVars: d.envVars.map((v) => ({
			id: uid(`env:${d.id}:${v.key}`),
			deploymentId: d.id,
			key: v.key,
			value: v.secret ? null : v.value,
			secret: v.secret,
			createdAt: d.createdAt,
			updatedAt: d.updatedAt
		})),
		imageHistory: imageHistory(store, d),
		creator: creator(store.user(d.creatorId))
	};
}

function timeline(store: Store, d: MockDeployment) {
	const entries = store.buildsOf(d.id).map((b) => {
		const by = store.user(b.triggeredById);
		return {
			id: `release:${b.id}`,
			at: b.createdAt,
			kind: b.status === 'succeeded' ? 'release' : 'build',
			actor: by
				? {
						id: by.id,
						username: by.username,
						email: by.email,
						firstName: by.firstName,
						lastName: by.lastName,
						imageUrl: by.imageUrl
					}
				: null,
			title: b.commitMessage ?? `Deployed ${b.image.split(':').at(-1)}`,
			detail: b.commitSha ? `${b.branch} · ${b.commitSha.slice(0, 7)}` : null,
			status: b.status,
			href: null,
			meta: {
				imageHistoryId: b.id,
				image: b.image,
				tag: b.image.split(':').at(-1),
				commitSha: b.commitSha,
				commitMessage: b.commitMessage,
				commitAuthorName: b.commitAuthorName,
				commitAuthorUsername: b.commitAuthorUsername,
				branch: b.branch,
				triggerType: b.triggerType === 'push' ? 'auto' : b.triggerType,
				isActive: b.isActive,
				buildStatus: b.status,
				buildStartedAt: b.buildStartedAt,
				buildCompletedAt: b.buildCompletedAt
			}
		};
	});
	if (d.crash) {
		entries.unshift({
			id: `pod:${d.id}:crash`,
			at: new Date(Date.now() - 40_000).toISOString(),
			kind: 'pod',
			actor: null,
			title: `${store.podName(d, 0)} crashed`,
			detail: d.crash.message,
			status: 'crashing',
			href: null,
			meta: {
				podName: store.podName(d, 0),
				fromStatus: 'ready',
				toStatus: 'crashing',
				reason: d.crash.reason
			} as any
		});
	}
	return entries;
}

function errorGroups(d: MockDeployment) {
	if (!d.host && !d.crash) return [];
	const now = Date.now();
	return [
		{
			fingerprint: sha(`${d.id}:err1`),
			type: d.crash ? 'RangeError' : 'PrismaClientKnownRequestError',
			message: d.crash
				? 'Invalid array length'
				: 'Unique constraint failed on the fields: (`slug`)',
			count: d.crash ? 412 : 37,
			status: 'unresolved',
			firstSeen: new Date(now - 86_400_000 * 2).toISOString(),
			lastSeen: new Date(now - 120_000).toISOString(),
			assignee: null,
			githubIssueUrl: null,
			stackTrace: `Error\n    at createProject (/app/src/projects.ts:88:11)\n    at async handler (/app/src/server.ts:41:5)`,
			firstDeploy: null,
			deployCount: 1,
			deploys: []
		}
	];
}

export function deploymentRoutes(r: Router, { store }: MockContext) {
	const find = (id: string) => store.deployment(id);
	const changed = (d: MockDeployment) => {
		store.touch(d);
		store.emit('deployment.changed', d.projectId, d.id);
	};
	const withDep = (fn: (d: MockDeployment, ctx: any) => unknown) => (ctx: any) => {
		const d = find(ctx.params.id);
		return d ? fn(d, ctx) : notFound('Deployment not found');
	};

	r.get('/deployments', () => store.state.deployments.map((d) => deploymentSummary(store, d)));
	r.get('/ingresses', () => store.state.deployments.flatMap(ingress));
	r.get('/deployments/favicon', () => reply(404, { message: 'No favicon in mock mode' }));
	r.get(
		'/deployments/:id',
		withDep((d) => deploymentDetail(store, d))
	);
	r.get(
		'/deployments/:id/pods-live',
		withDep((d) => {
			const pods = podsOf(store, d);
			return {
				pods,
				warnings: warnings(store, d),
				availableReplicas: pods.filter((p) => p.status === 'ready').length,
				totalCpuUsage: pods.reduce((a, p) => a + (p.cpuUsage ?? 0), 0),
				totalMemoryUsage: pods.reduce((a, p) => a + (p.memoryUsage ?? 0), 0),
				meteredPods: pods.length
			};
		})
	);
	r.get(
		'/deployments/:id/build-logs',
		withDep((d) => ({ logs: d.buildLogs }))
	);
	r.get(
		'/deployments/:id/logs',
		withDep((d) => ({ logs: d.buildLogs }))
	);
	r.get(
		'/deployments/:id/build-runs',
		withDep((d) =>
			store
				.buildsOf(d.id)
				.slice(0, 20)
				.map((b) => ({
					id: b.id,
					status: b.status === 'canceled' ? 'canceled' : b.status,
					triggerType: b.triggerType,
					commitSha: b.commitSha,
					commitMessage: b.commitMessage,
					branch: b.branch,
					createdAt: b.createdAt
				}))
		)
	);
	r.get('/deployments/:id/image-history/:hid/logs', ({ params }) => {
		const b = store.state.builds.find((x) => x.id === params.hid);
		if (!b) return notFound();
		return {
			logs:
				b.logs ||
				[
					'#1 [internal] load build definition from Dockerfile',
					'#1 DONE 0.1s',
					'#2 [deps 2/5] RUN pnpm install --frozen-lockfile',
					'#2 CACHED',
					'#3 [build 3/5] RUN pnpm build',
					'#3 DONE 14.2s',
					`#4 exporting to image ${b.image}`,
					'#4 DONE 3.8s'
				].join('\n')
		};
	});
	r.get('/deployments/:id/bindings', () => []);
	r.get(
		'/deployments/:id/bindings/options',
		withDep((d) =>
			store.databasesOf(d.projectId).map((db) => ({
				resourceType: 'database',
				resourceId: db.id,
				name: db.name,
				status: db.status,
				endpoint: `${db.name}-cluster-rw:5432`,
				suggestedName: `${db.name.toUpperCase()}_URL`
			}))
		)
	);
	r.get('/deployments/:id/anomalies', () => ({ anomalies: [] }));
	r.get(
		'/deployments/:id/next-steps',
		withDep((d) => ({
			steps: [
				{ id: 'auto-deploy', applicable: Boolean(d.githubRepo), done: d.autoDeployEnabled },
				{ id: 'domain', applicable: true, done: Boolean(d.host) },
				{ id: 'resources', applicable: true, done: true },
				{ id: 'notifications', applicable: true, done: false },
				{ id: 'health-check', applicable: Boolean(d.host), done: Boolean(d.host) },
				{ id: 'cli', applicable: true, done: false }
			]
		}))
	);
	r.get('/deployments/:id/webhook-tokens', () => []);
	r.get(
		'/deployments/:id/auto-deploy',
		withDep((d) => ({
			enabled: d.autoDeployEnabled,
			branch: d.githubBranch ?? 'main',
			paths: [],
			appInstalled: true,
			linked: true,
			deliverable: true,
			message: null,
			provider: null
		}))
	);
	r.get('/deployments/:id/github-deployments', () => []);
	r.get(
		'/deployments/:id/killed-containers',
		withDep((d) =>
			d.crash
				? [
						{
							entryId: uid(`killed:${d.id}`),
							pod: store.podName(d, 0),
							container: d.name,
							reason: d.crash.reason,
							exitCode: d.crash.exitCode,
							finishedAt: new Date(Date.now() - 40_000).toISOString(),
							capturedAt: new Date(Date.now() - 39_000).toISOString()
						}
					]
				: []
		)
	);
	r.get(
		'/deployments/:id/killed-containers/:entryId/logs',
		withDep((d) => {
			const lines = tail(d, [store.podName(d, 0)], 40).map((l) => l.line);
			return {
				entryId: uid(`killed:${d.id}`),
				pod: store.podName(d, 0),
				container: d.name,
				reason: d.crash?.reason ?? 'Completed',
				exitCode: d.crash?.exitCode ?? 0,
				finishedAt: new Date(Date.now() - 40_000).toISOString(),
				capturedAt: new Date(Date.now() - 39_000).toISOString(),
				logs: `${lines.join('\n')}\n`
			};
		})
	);
	r.get(
		'/deployments/:id/metrics',
		withDep((d, { query }) => {
			const base = metricSeries(query, d.cpuUsageMilli, Math.round(d.memoryUsageBytes / MIB));
			if (query.get('groupBy') !== 'pod') return base;
			const pods = podsOf(store, d);
			const split = (key: 'cpu' | 'mem' | 'rx' | 'tx') =>
				pods.map((p, i) => ({
					key: p.name,
					points: base.data[key].map((pt) => ({
						x: pt.x,
						y: +((pt.y / pods.length) * (1 + (i - pods.length / 2) * 0.08)).toFixed(2)
					}))
				}));
			return {
				start: base.start,
				end: base.end,
				step: base.step,
				groupBy: 'pod',
				grouped: { cpu: split('cpu'), mem: split('mem'), rx: split('rx'), tx: split('tx') }
			};
		})
	);
	r.get('/organizations/:orgId/metric-alerts/states', () => []);
	r.get('/organizations/:orgId/metric-alerts', () => []);
	r.get('/organizations/:orgId/metric-alerts/catalogue', () => []);
	r.get('/organizations/:orgId/notification-rules', () => []);

	r.get(
		'/observe/deployments/:id/capabilities',
		withDep((d) => ({
			logs: true,
			containerMetrics: true,
			httpMetrics: Boolean(d.host),
			httpMetricsShared: false,
			customMetrics: false,
			traces: false,
			runtime: {
				language: d.framework === 'rails' ? 'ruby' : 'node',
				framework: d.framework,
				version: d.framework === 'rails' ? '3.3.5' : '22.12.0',
				confidence: 'high',
				detectedFrom: 'image'
			}
		}))
	);
	r.get(
		'/observe/deployments/:id/overview',
		withDep((d) => {
			const pods = podsOf(store, d);
			return {
				uptime: d.podStartedAt,
				podCount: pods.length,
				restarts: d.restarts,
				cpuPercent: Math.round((d.cpuUsageMilli / d.cpuRequestMilli) * 100),
				memoryPercent: Math.round((d.memoryUsageBytes / d.memoryRequestBytes) * 100),
				httpRequestRate: d.host ? 14.2 : null,
				httpErrorRate: d.host ? 0.4 : null,
				httpAvgLatency: d.host ? 38 : null
			};
		})
	);
	r.get(
		'/observe/deployments/:id/logs/structured',
		withDep((d, { query }) => {
			const pods = podsOf(store, d).map((p) => p.name);
			const n = Math.min(Number(query.get('tailLines') ?? 1000), 600);
			const level = query.get('level');
			const search = query.get('search')?.toLowerCase();
			const entries = tail(d, pods, n)
				.filter((l) => !level || l.level === level)
				.filter((l) => !search || l.message.toLowerCase().includes(search))
				.map(structured);
			return { entries };
		})
	);
	r.get(
		'/observe/deployments/:id/logs/stream',
		withDep((d, { res }) => {
			openStream(res);
			let cursor = Date.now();
			const tick = setInterval(() => {
				const pods = podsOf(store, d).map((p) => p.name);
				const now = Date.now();
				const lines = since(d, pods, cursor, now).map((l) => ({
					pod: l.pod,
					ts: l.ts,
					line: l.line
				}));
				cursor = now;
				if (lines.length) writeMessage(res, { lines }, lines.at(-1)!.ts);
			}, BUCKET_MS);
			const heartbeat = setInterval(
				() => writeMessage(res, { type: 'heartbeat', ts: Date.now() }),
				15_000
			);
			res.on('close', () => {
				clearInterval(tick);
				clearInterval(heartbeat);
			});
			return STREAMING;
		})
	);
	r.get(
		'/observe/deployments/:id/build-logs/stream',
		withDep((d, { res }) => {
			openStream(res);
			let sent = 0;
			const tick = setInterval(() => {
				if (d.buildLogs.length > sent) {
					writeMessage(res, { chunk: d.buildLogs.slice(sent) });
					sent = d.buildLogs.length;
				}
				if (d.buildStatus !== 'building') writeMessage(res, { done: true, status: d.buildStatus });
			}, 1_000);
			res.on('close', () => clearInterval(tick));
			return STREAMING;
		})
	);
	r.get(
		'/observe/deployments/:id/errors',
		withDep((d) => ({
			repoUrl: d.githubRepo ? `https://github.com/${d.githubRepo}` : null,
			assignable: store.state.users
				.slice(0, 3)
				.map((u) => ({ id: u.id, username: u.username, imageUrl: u.imageUrl })),
			errors: errorGroups(d)
		}))
	);
	r.patch('/observe/deployments/:id/errors/:fp', () => ({ ok: true }));
	r.get(
		'/observe/deployments/:id/http-metrics',
		withDep((_d, { query }) => {
			const { start, end, step } = metricsWindow(query);
			const pts = (base: number, wobble: number) => {
				const out: { x: number; y: number }[] = [];
				for (let t = start - (start % step); t <= end; t += step) {
					out.push({ x: t, y: +Math.max(0, base + Math.sin(t / 420_000) * wobble).toFixed(2) });
				}
				return out;
			};
			return {
				requestRate: pts(14, 6),
				errorRate: pts(0.4, 0.3),
				latencyAvg: pts(38, 12),
				latencyMax: pts(220, 90)
			};
		})
	);
	r.get(
		'/observe/deployments/:id/timeline',
		withDep((d, { query }) => {
			const kinds = query.get('kinds')?.split(',');
			const limit = Number(query.get('limit') ?? 40);
			const all = timeline(store, d).filter((e) => !kinds || kinds.includes(e.kind));
			return { entries: all.slice(0, limit), nextCursor: null };
		})
	);

	r.get('/pods/:pod/logs', ({ params, query }) => {
		const n = Math.min(Number(query.get('tailLines') ?? 100), 2000);
		const d = store.state.deployments.find((x) =>
			podsOf(store, x).some((p) => p.name === params.pod)
		);
		if (!d) return { logs: pgLogs(n) };
		return {
			logs: `${tail(d, [params.pod], n)
				.map((l) => `${l.ts} ${l.line}`)
				.join('\n')}\n`
		};
	});
	r.get('/pods/:pod', ({ params }) => {
		for (const d of store.state.deployments) {
			const pod = podsOf(store, d).find((p) => p.name === params.pod);
			if (!pod) continue;
			const container = pod.containers[0];
			return {
				metadata: {
					name: pod.name,
					namespace: namespaceOf(store, d),
					creationTimestamp: pod.startTime,
					labels: { app: d.name, 'orchard.my/deployment': d.id }
				},
				spec: {
					nodeName: pod.nodeName,
					containers: [{ name: container.name, image: container.image }]
				},
				status: {
					phase: pod.status === 'ready' ? 'Running' : 'Pending',
					podIP: pod.podIp,
					hostIP: `192.168.1.${10 + d.name.length}`,
					startTime: pod.startTime,
					containerStatuses: [
						{
							name: container.name,
							image: container.image,
							ready: container.ready,
							restartCount: container.restartCount,
							state: container.ready
								? { running: { startedAt: pod.startTime } }
								: { waiting: { reason: 'CrashLoopBackOff' } },
							lastState: container.lastTermination ? { terminated: container.lastTermination } : {}
						}
					]
				}
			};
		}
		return notFound('Pod not found');
	});
	r.delete('/pods/:pod', ({ params }) => {
		const d = store.state.deployments.find((x) =>
			podsOf(store, x).some((p) => p.name === params.pod)
		);
		if (d) store.restart(d.id);
		return { ok: true };
	});

	r.post(
		'/deployments/:id/rebuild',
		withDep((d) => {
			const b = store.redeploy(d.id, { trigger: 'manual' });
			return { ok: true, buildId: b?.id };
		})
	);
	r.post(
		'/deployments/:id/redeploy',
		withDep((d) => {
			const b = store.redeploy(d.id, { trigger: 'manual', rebuild: false });
			return { ok: true, buildId: b?.id };
		})
	);
	r.post(
		'/deployments/:id/cancel',
		withDep((d) => {
			store.cancelBuild(d.id);
			return { ok: true };
		})
	);
	r.post(
		'/deployments/:id/restart',
		withDep((d) => {
			store.restart(d.id);
			return { ok: true };
		})
	);
	r.post(
		'/deployments/:id/stop',
		withDep((d) => {
			store.setStopped(d.id, true);
			return { ok: true, stopped: true };
		})
	);
	r.post(
		'/deployments/:id/start',
		withDep((d, { body }) => {
			if (body?.build) store.redeploy(d.id, { trigger: 'manual' });
			else store.setStopped(d.id, false);
			return { ok: true, stopped: false };
		})
	);
	r.post(
		'/deployments/:id/scale',
		withDep((d, { body }) => {
			store.scale(d.id, Number(body?.replicas ?? d.replicas));
			return { replicas: d.replicas, stopped: d.stopped };
		})
	);
	r.post(
		'/deployments/:id/rollback/:hid',
		withDep((d, { params }) => {
			const target = store.state.builds.find((b) => b.id === params.hid);
			if (!target) return notFound();
			for (const b of store.state.builds)
				if (b.deploymentId === d.id) b.isActive = b.id === target.id;
			d.image = target.image;
			store.restart(d.id);
			store.emit('build.changed', d.projectId, d.id);
			return { ok: true };
		})
	);
	r.post(
		'/deployments/:id/retry-apply',
		withDep((d) => {
			changed(d);
			return { ok: true };
		})
	);
	r.delete(
		'/deployments/:id',
		withDep((d) => {
			store.removeDeployment(d.id);
			return { ok: true };
		})
	);
	r.patch(
		'/deployments/:id/name',
		withDep((d, { body }) => {
			d.displayName = body?.name ? String(body.name) : null;
			changed(d);
			return { displayName: d.displayName };
		})
	);
	r.put(
		'/deployments/:id/env',
		withDep((d, { body }) => {
			const prev = new Map(d.envVars.map((v) => [v.key, v]));
			d.envVars = (body?.env ?? [])
				.filter((v: any) => v?.key)
				.map((v: any) => ({
					key: String(v.key),
					value:
						v.value === null || (v.secret && v.value === '')
							? (prev.get(v.key)?.value ?? '')
							: String(v.value ?? ''),
					secret: Boolean(v.secret)
				}));
			changed(d);
			store.restart(d.id);
			return deploymentDetail(store, d);
		})
	);
	r.put(
		'/deployments/:id/volumes',
		withDep((d, { body }) => {
			d.volumes = (body?.volumes ?? []).map((v: any) => ({
				id: freshId(),
				name: String(v.name),
				type: v.type ?? 'pvc',
				mountPath: String(v.mountPath),
				storageSize: v.storageSize ?? '1Gi',
				readOnly: Boolean(v.readOnly)
			}));
			changed(d);
			return deploymentDetail(store, d);
		})
	);
	r.patch(
		'/deployments/:id/resources',
		withDep((d, { body }) => {
			if (body?.cpuRequestMilli != null) d.cpuRequestMilli = Number(body.cpuRequestMilli);
			if (body?.memoryRequestBytes != null) d.memoryRequestBytes = Number(body.memoryRequestBytes);
			if (d.crash?.reason === 'OOMKilled' && d.memoryRequestBytes > d.memoryUsageBytes * 1.5) {
				d.crash = null;
				d.restarts = 0;
			}
			store.restart(d.id);
			return deploymentDetail(store, d);
		})
	);
	r.patch(
		'/deployments/:id/image',
		withDep((d, { body }) => {
			if (body?.image) d.image = String(body.image);
			store.redeploy(d.id, { trigger: 'manual', rebuild: false });
			return deploymentDetail(store, d);
		})
	);
	for (const path of ['build-config', 'health-check']) {
		r.put(
			`/deployments/:id/${path}`,
			withDep((d, { body }) => {
				if (body?.buildType) d.buildType = body.buildType;
				if (body?.framework !== undefined) d.framework = body.framework;
				changed(d);
				return { ...deploymentDetail(store, d), ...(body ?? {}) };
			})
		);
	}
	for (const path of ['strategy', 'disruption-budget', 'pull-policy']) {
		r.patch(
			`/deployments/:id/${path}`,
			withDep((d) => {
				changed(d);
				return { ok: true };
			})
		);
	}
	r.post(
		'/deployments/:id/auto-deploy/enable',
		withDep((d, { body }) => {
			d.autoDeployEnabled = true;
			if (body?.branch) d.githubBranch = String(body.branch);
			changed(d);
			return { ...deploymentDetail(store, d), autoDeployPaths: body?.paths ?? [] };
		})
	);
	r.post(
		'/deployments/:id/auto-deploy/disable',
		withDep((d) => {
			d.autoDeployEnabled = false;
			changed(d);
			return deploymentDetail(store, d);
		})
	);
	r.post(
		'/deployments/:id/services',
		withDep((d) => deploymentDetail(store, d))
	);
	r.put(
		'/deployments/:id/services/:sid',
		withDep((d) => deploymentDetail(store, d))
	);
	r.delete(
		'/deployments/:id/services/:sid',
		withDep((d) => deploymentDetail(store, d))
	);

	r.post('/projects/ingresses/validate-dns', () => ({ valid: true, message: 'DNS looks good' }));
	r.post('/projects/:pid/ingresses', ({ params, body }) => {
		const d =
			store.deployment(body?.deploymentId ?? '') ??
			store.deploymentsOf(params.pid).find((x) => x.name === body?.routes?.[0]?.serviceName);
		if (d && body?.host) {
			d.host = String(body.host);
			changed(d);
		}
		return { ok: true };
	});
	r.put('/projects/:pid/ingresses/:iid', ({ body, params }) => {
		const d = store.deploymentsOf(params.pid).find((x) => uid(`ing:${x.id}`) === params.iid);
		if (d && body?.host) {
			d.host = String(body.host);
			changed(d);
		}
		return { ok: true };
	});
	r.delete('/projects/:pid/ingresses/:iid', ({ params }) => {
		const d = store.deploymentsOf(params.pid).find((x) => uid(`ing:${x.id}`) === params.iid);
		if (d) {
			d.host = null;
			changed(d);
		}
		return { ok: true };
	});

	const create = ({ params, body }: { params: Record<string, string>; body: any }) => {
		const p = store.project(params.pid ?? body?.projectId ?? '');
		if (!p) return reply(400, { message: 'projectId is required' });
		const name = slugify(String(body?.name ?? 'app')) || 'app';
		const env =
			store.state.environments.find((e) => e.id === body?.environmentId) ??
			store.state.environments.find((e) => e.projectId === p.id && e.isDefault);
		const rawRepo = body?.repoUrl ?? body?.githubRepo;
		const repo = rawRepo
			? String(rawRepo)
					.replace(/^https:\/\/github.com\//, '')
					.replace(/\.git$/, '')
			: null;
		const now = new Date().toISOString();
		const d: MockDeployment = {
			id: store.newDeploymentId(p.id, name),
			projectId: p.id,
			environmentId: env?.id ?? '',
			name,
			displayName: null,
			status: 'pending',
			buildStatus: 'pending',
			buildStep: 'queued',
			buildStepTimestamps: {},
			buildError: null,
			buildLogs: '',
			replicas: Number(body?.replicas ?? 1),
			stopped: false,
			image: body?.image ?? `registry.orchard.my/${p.slug}/${name}:latest`,
			githubRepo: repo,
			githubBranch: repo ? (body?.branch ?? body?.githubBranch ?? 'main') : null,
			buildType: body?.buildType ?? 'railpack',
			framework: body?.framework ?? null,
			host: body?.autoUrl === false ? null : `${name}-${p.slug}.orchard.my`,
			port: Number(body?.ports?.[0]?.containerPort ?? body?.port ?? 3000),
			cpuRequestMilli: Number(body?.cpuRequestMilli ?? 500),
			memoryRequestBytes: Number(body?.memoryRequestBytes ?? 512 * MIB),
			cpuUsageMilli: 30,
			memoryUsageBytes: 140 * MIB,
			envVars: (body?.env ?? body?.envVars ?? []).map((v: any) => ({
				key: String(v.key),
				value: String(v.value ?? ''),
				secret: Boolean(v.secret)
			})),
			volumes: [],
			crash: null,
			podSeed: sha(now).slice(0, 10),
			podStartedAt: now,
			restarts: 0,
			creatorId: store.state.meId,
			autoDeployEnabled: Boolean(repo),
			createdAt: now,
			updatedAt: now
		};
		store.state.deployments.push(d);
		store.redeploy(d.id, { trigger: 'manual' });
		return deploymentDetail(store, d);
	};
	r.post('/deployments', create);
	r.post('/projects/:pid/deployments', create);
	r.post('/projects/:pid/deployments/from-github', create);
}

const PG = [
	'LOG:  checkpoint starting: time',
	'LOG:  checkpoint complete: wrote 312 buffers (1.9%); 0 WAL file(s) added, 0 removed, 1 recycled',
	'LOG:  archive command succeeded for 0000000100000004000000A7',
	'LOG:  connection received: host=10.42.3.18 port=51244',
	'LOG:  connection authorized: user=app database=app application_name=prisma',
	'LOG:  duration: 112.402 ms  statement: SELECT "public"."User".* FROM "public"."User" WHERE "id" = $1'
];

function pgLogs(n: number) {
	const now = Date.now();
	const lines: string[] = [];
	for (let i = Math.min(n, 400); i > 0; i--) {
		lines.push(
			`${new Date(now - i * 4_000).toISOString()} [${100 + (i % 7)}] ${PG[i % PG.length]}`
		);
	}
	return `${lines.join('\n')}\n`;
}
