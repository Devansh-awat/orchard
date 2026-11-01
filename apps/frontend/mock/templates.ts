export type MockTemplate = {
	name: string;
	displayName: string;
	description: string;
	icon: string | null;
	category: string;
};

export const TEMPLATES: MockTemplate[] = [
	{
		name: 'n8n',
		displayName: 'n8n',
		description: 'Workflow automation with a visual editor and hundreds of integrations.',
		icon: 'https://assets.orchard.my/registry/templates/n8n/1.0.0/icon.jpg',
		category: 'automation'
	},
	{
		name: 'ghost',
		displayName: 'Ghost Blog',
		description:
			'Modern publishing platform powered by Ghost with PostgreSQL storage and public domain.',
		icon: 'https://assets.orchard.my/registry/templates/ghost/1.0.0/icon.png',
		category: 'cms'
	},
	{
		name: 'uptime-kuma',
		displayName: 'Uptime Kuma',
		description: 'Uptime monitoring with status pages and notifications to just about anything.',
		icon: 'https://assets.orchard.my/registry/templates/uptime-kuma/1.0.0/icon.svg',
		category: 'monitoring'
	},
	{
		name: 'plausible',
		displayName: 'Plausible',
		description:
			'Lightweight, privacy-first web analytics. Ships with its own ClickHouse and Postgres.',
		icon: 'https://assets.orchard.my/registry/templates/plausible/1.0.0/icon.png',
		category: 'analytics'
	},
	{
		name: 'vaultwarden',
		displayName: 'Vaultwarden',
		description: 'A Bitwarden-compatible password server that runs in a few megabytes of RAM.',
		icon: 'https://assets.orchard.my/registry/templates/vaultwarden/1.0.0/icon.svg',
		category: 'security'
	},
	{
		name: 'open-webui',
		displayName: 'Open WebUI',
		description:
			'A chat interface for any OpenAI-compatible API, with accounts, history and document uploads.',
		icon: 'https://assets.orchard.my/registry/templates/open-webui/1.0.0/icon.png',
		category: 'ai'
	},
	{
		name: 'outline',
		displayName: 'Outline',
		description:
			'A team wiki with a fast editor. Needs an OpenID Connect provider to sign in, so pair it with Keycloak.',
		icon: 'https://assets.orchard.my/registry/templates/outline/1.0.0/icon.jpg',
		category: 'docs'
	},
	{
		name: 'minecraft',
		displayName: 'Minecraft Server',
		description:
			'A Paper, Vanilla, Fabric, Forge or modpack server on a public port, with the world on a volume. Every server.properties knob is a parameter.',
		icon: null,
		category: 'games'
	},
	{
		name: 'redis-oss',
		displayName: 'Redis',
		description:
			'In-memory data store for caches, queues and sessions. Internal-only, no public exposure.',
		icon: 'https://github.com/redis.png?size=256',
		category: 'database'
	},
	{
		name: 'redis',
		displayName: 'Valkey Cache',
		description: 'In-memory key-value cache, Redis-compatible. Internal-only, no public exposure.',
		icon: 'https://assets.orchard.my/registry/templates/redis/1.1.0/icon.png',
		category: 'database'
	},
	{
		name: 'mongo',
		displayName: 'MongoDB',
		description:
			'A document database for the apps that need one. Internal-only, no public exposure.',
		icon: 'https://assets.orchard.my/registry/templates/mongo/1.0.0/icon.jpg',
		category: 'database'
	},
	{
		name: 'mariadb',
		displayName: 'MariaDB',
		description:
			'A MySQL-compatible database for the apps that will not talk to Postgres. Internal-only, no public exposure.',
		icon: 'https://assets.orchard.my/registry/templates/mariadb/1.0.0/icon.png',
		category: 'database'
	},
	{
		name: 'clickhouse',
		displayName: 'ClickHouse',
		description:
			'A column store for analytics at scale. Internal-only; what Plausible and Langfuse want underneath.',
		icon: 'https://assets.orchard.my/registry/templates/clickhouse/1.0.0/icon.png',
		category: 'database'
	},
	{
		name: 'qdrant',
		displayName: 'Qdrant',
		description: 'A vector database for embeddings and similarity search. Internal-only.',
		icon: 'https://assets.orchard.my/registry/templates/qdrant/1.0.0/icon.png',
		category: 'database'
	},
	{
		name: 'meilisearch',
		displayName: 'Meilisearch',
		description:
			'A fast, typo-tolerant search engine with an easy API. Internal-only; front it from your app.',
		icon: 'https://assets.orchard.my/registry/templates/meilisearch/1.0.0/icon.png',
		category: 'database'
	},
	{
		name: 'typesense',
		displayName: 'Typesense',
		description:
			'An open-source search engine built for instant results. Internal-only; front it from your app.',
		icon: 'https://assets.orchard.my/registry/templates/typesense/1.0.0/icon.png',
		category: 'database'
	},
	{
		name: 'nephthys',
		displayName: 'Nephthys',
		description:
			'A Slack help desk bot: questions in a channel become tickets your team can claim and close.',
		icon: null,
		category: 'automation'
	},
	{
		name: 'pocketbase',
		displayName: 'PocketBase',
		description:
			'A backend in one file: SQLite, realtime, auth and an admin UI. Create the first admin on first visit.',
		icon: 'https://assets.orchard.my/registry/templates/pocketbase/1.0.0/icon.png',
		category: 'backend'
	},
	{
		name: 'code-server',
		displayName: 'code-server',
		description: 'VS Code in the browser, with your home directory on a volume.',
		icon: 'https://assets.orchard.my/registry/templates/code-server/1.0.0/icon.png',
		category: 'developer'
	},
	{
		name: 'forgejo',
		displayName: 'Forgejo',
		description:
			'A community-run Git service with issues, pull requests and Actions. The Codeberg fork of Gitea.',
		icon: 'https://assets.orchard.my/registry/templates/forgejo/1.0.0/icon.png',
		category: 'developer'
	},
	{
		name: 'grafana',
		displayName: 'Grafana',
		description:
			'Dashboards over Prometheus, Postgres, Loki and everything else. Config in Postgres so the pod is disposable.',
		icon: 'https://assets.orchard.my/registry/templates/grafana/1.0.0/icon.jpg',
		category: 'monitoring'
	},
	{
		name: 'mailpit',
		displayName: 'Mailpit',
		description:
			'A fake SMTP server with a web inbox. Point your app at it and read every email it sends.',
		icon: 'https://assets.orchard.my/registry/templates/mailpit/1.0.0/icon.svg',
		category: 'developer'
	},
	{
		name: 'it-tools',
		displayName: 'IT Tools',
		description:
			'A hundred small developer utilities on one page: encoders, hashes, converters, generators. No configuration.',
		icon: 'https://assets.orchard.my/registry/templates/it-tools/1.0.0/icon.png',
		category: 'developer'
	},
	{
		name: 'excalidraw',
		displayName: 'Excalidraw',
		description: 'A whiteboard with a hand-drawn feel. No accounts, drawings stay in the browser.',
		icon: 'https://assets.orchard.my/registry/templates/excalidraw/1.0.0/icon.png',
		category: 'developer'
	},
	{
		name: 'pgadmin',
		displayName: 'pgAdmin',
		description: 'The Postgres admin UI. Point it at your managed databases.',
		icon: 'https://assets.orchard.my/registry/templates/pgadmin/1.0.0/icon.png',
		category: 'developer'
	},
	{
		name: 'drawio',
		displayName: 'draw.io',
		description:
			'Diagrams in the browser: flowcharts, architecture, UML. Export to PNG, SVG or PDF.',
		icon: 'https://assets.orchard.my/registry/templates/drawio/1.0.0/icon.png',
		category: 'developer'
	}
];

export function templateRow(t: MockTemplate, i: number) {
	return {
		id: `tpl_${t.name}`,
		name: t.name,
		displayName: t.displayName,
		description: t.description,
		icon: t.icon,
		version: '1.0.0',
		category: t.category,
		tags: [t.category],
		isBuiltIn: i < 3,
		source: 'registry'
	};
}
