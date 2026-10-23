import type { SpotlightItem } from '$lib/components/patterns/ProjectSpotlight.svelte';
import type { ShelfItem } from '$lib/components/patterns/Shelf.svelte';
import { PROJECTS, MORE_PROJECTS, BUILD_FEED } from './fixtures';

const [site, terra] = PROJECTS;
const [flavortown] = MORE_PROJECTS;
const building = BUILD_FEED[0];

export const SPOTLIGHT: SpotlightItem[] = [
	{
		id: terra.id,
		name: terra.name,
		href: '#',
		url: 'https://worker-arcade-leaderboard.orchard.my',
		image: terra.image,
		background: terra.background,
		owner: terra.owner,
		status: 'worker is crashing · out of memory',
		tone: 'error',
		apps: terra.entities.map((e) => ({ name: e.name, kind: e.kind }))
	},
	{
		id: site.id,
		name: site.name,
		href: '#',
		url: 'https://hackclub-site.orchard.my',
		image: site.image,
		background: site.background,
		owner: site.owner,
		status: `${building.app} is building · ${building.branch} · ${building.message}`,
		tone: 'progress',
		apps: site.entities.map((e) => ({ name: e.name, kind: e.kind }))
	},
	{
		id: flavortown.id,
		name: flavortown.name,
		href: '#',
		url: 'https://flavortown.hackclub.com',
		image: flavortown.image,
		owner: flavortown.owner,
		status: `All ${flavortown.entities?.length ?? 0} apps running`,
		tone: 'success',
		apps: (flavortown.entities ?? []).map((e) => ({ name: e.name, kind: e.kind }))
	}
];

const CATEGORY: Record<string, string> = {
	automation: 'Automation',
	cms: 'Publishing',
	monitoring: 'Monitoring',
	analytics: 'Analytics',
	security: 'Security',
	ai: 'AI',
	docs: 'Docs',
	games: 'Games',
	database: 'Database',
	backend: 'Backend',
	developer: 'Developer'
};

const tpl = (
	id: string,
	title: string,
	description: string,
	icon: string | null,
	category: string
): ShelfItem => ({
	id,
	title,
	subtitle: CATEGORY[category] ?? category,
	description,
	href: '#',
	icon
});

export const TEMPLATE_SHELVES: { title: string; items: ShelfItem[] }[] = [
	{
		title: 'Popular',
		items: [
			tpl(
				'n8n',
				'n8n',
				'Workflow automation with a visual editor and hundreds of integrations.',
				'https://assets.orchard.my/registry/templates/n8n/1.0.0/icon.jpg',
				'automation'
			),
			tpl(
				'ghost',
				'Ghost Blog',
				'Modern publishing platform powered by Ghost with PostgreSQL storage and public domain.',
				'https://assets.orchard.my/registry/templates/ghost/1.0.0/icon.png',
				'cms'
			),
			tpl(
				'uptime-kuma',
				'Uptime Kuma',
				'Uptime monitoring with status pages and notifications to just about anything.',
				'https://assets.orchard.my/registry/templates/uptime-kuma/1.0.0/icon.svg',
				'monitoring'
			),
			tpl(
				'plausible',
				'Plausible',
				'Lightweight, privacy-first web analytics. Ships with its own ClickHouse and Postgres.',
				'https://assets.orchard.my/registry/templates/plausible/1.0.0/icon.png',
				'analytics'
			),
			tpl(
				'vaultwarden',
				'Vaultwarden',
				'A Bitwarden-compatible password server that runs in a few megabytes of RAM.',
				'https://assets.orchard.my/registry/templates/vaultwarden/1.0.0/icon.svg',
				'security'
			),
			tpl(
				'open-webui',
				'Open WebUI',
				'A chat interface for any OpenAI-compatible API, with accounts, history and document uploads.',
				'https://assets.orchard.my/registry/templates/open-webui/1.0.0/icon.png',
				'ai'
			),
			tpl(
				'outline',
				'Outline',
				'A team wiki with a fast editor. Needs an OpenID Connect provider to sign in, so pair it with Keycloak.',
				'https://assets.orchard.my/registry/templates/outline/1.0.0/icon.jpg',
				'docs'
			),
			tpl(
				'minecraft',
				'Minecraft Server',
				'A Paper, Vanilla, Fabric, Forge or modpack server on a public port, with the world on a volume. Every server.properties knob is a parameter.',
				null,
				'games'
			)
		]
	},
	{
		title: 'Databases',
		items: [
			tpl(
				'redis',
				'Valkey Cache',
				'In-memory key-value cache, Redis-compatible. Internal-only, no public exposure.',
				'https://assets.orchard.my/registry/templates/redis/1.1.0/icon.png',
				'database'
			),
			tpl(
				'mongo',
				'MongoDB',
				'A document database for the apps that need one. Internal-only, no public exposure.',
				'https://assets.orchard.my/registry/templates/mongo/1.0.0/icon.jpg',
				'database'
			),
			tpl(
				'mariadb',
				'MariaDB',
				'A MySQL-compatible database for the apps that will not talk to Postgres. Internal-only, no public exposure.',
				'https://assets.orchard.my/registry/templates/mariadb/1.0.0/icon.png',
				'database'
			),
			tpl(
				'clickhouse',
				'ClickHouse',
				'A column store for analytics at scale. Internal-only; what Plausible and Langfuse want underneath.',
				'https://assets.orchard.my/registry/templates/clickhouse/1.0.0/icon.png',
				'database'
			),
			tpl(
				'qdrant',
				'Qdrant',
				'A vector database for embeddings and similarity search. Internal-only.',
				'https://assets.orchard.my/registry/templates/qdrant/1.0.0/icon.png',
				'database'
			),
			tpl(
				'meilisearch',
				'Meilisearch',
				'A fast, typo-tolerant search engine with an easy API. Internal-only; front it from your app.',
				'https://assets.orchard.my/registry/templates/meilisearch/1.0.0/icon.png',
				'database'
			),
			tpl(
				'typesense',
				'Typesense',
				'An open-source search engine built for instant results. Internal-only; front it from your app.',
				'https://assets.orchard.my/registry/templates/typesense/1.0.0/icon.png',
				'database'
			),
			tpl(
				'pocketbase',
				'PocketBase',
				'A backend in one file: SQLite, realtime, auth and an admin UI. Create the first admin on first visit.',
				'https://assets.orchard.my/registry/templates/pocketbase/1.0.0/icon.png',
				'backend'
			)
		]
	},
	{
		title: 'Developer tools',
		items: [
			tpl(
				'code-server',
				'code-server',
				'VS Code in the browser, with your home directory on a volume.',
				'https://assets.orchard.my/registry/templates/code-server/1.0.0/icon.png',
				'developer'
			),
			tpl(
				'forgejo',
				'Forgejo',
				'A community-run Git service with issues, pull requests and Actions. The Codeberg fork of Gitea.',
				'https://assets.orchard.my/registry/templates/forgejo/1.0.0/icon.png',
				'developer'
			),
			tpl(
				'grafana',
				'Grafana',
				'Dashboards over Prometheus, Postgres, Loki and everything else. Config in Postgres so the pod is disposable.',
				'https://assets.orchard.my/registry/templates/grafana/1.0.0/icon.jpg',
				'monitoring'
			),
			tpl(
				'mailpit',
				'Mailpit',
				'A fake SMTP server with a web inbox. Point your app at it and read every email it sends.',
				'https://assets.orchard.my/registry/templates/mailpit/1.0.0/icon.svg',
				'developer'
			),
			tpl(
				'it-tools',
				'IT Tools',
				'A hundred small developer utilities on one page: encoders, hashes, converters, generators. No configuration.',
				'https://assets.orchard.my/registry/templates/it-tools/1.0.0/icon.png',
				'developer'
			),
			tpl(
				'excalidraw',
				'Excalidraw',
				'A whiteboard with a hand-drawn feel. No accounts, drawings stay in the browser.',
				'https://assets.orchard.my/registry/templates/excalidraw/1.0.0/icon.png',
				'developer'
			),
			tpl(
				'pgadmin',
				'pgAdmin',
				'The Postgres admin UI. Point it at your managed databases.',
				'https://assets.orchard.my/registry/templates/pgadmin/1.0.0/icon.png',
				'developer'
			),
			tpl(
				'drawio',
				'draw.io',
				'Diagrams in the browser: flowcharts, architecture, UML. Export to PNG, SVG or PDF.',
				'https://assets.orchard.my/registry/templates/drawio/1.0.0/icon.png',
				'developer'
			)
		]
	}
];
