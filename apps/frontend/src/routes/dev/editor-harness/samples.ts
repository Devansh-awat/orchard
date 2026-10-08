import type { EditorFs } from '$lib/components/sandbox/editor';

export const ROOT = '/persist/home/dev/acme-api';

interface Sample {
	head: string | null;
	working: string;
}

const SERVER_HEAD = `import { createServer } from 'node:http';
import { loadConfig } from './config';
import { db } from './db';

const config = loadConfig();

export async function handle(path: string): Promise<Response> {
	if (path === '/health') {
		return new Response('ok');
	}
	const rows = await db.query('select * from orders');
	return Response.json(rows);
}

createServer(async (req, res) => {
	const response = await handle(req.url ?? '/');
	res.writeHead(response.status);
	res.end(await response.text());
}).listen(config.port);
`;

const SERVER_WORKING = `import { createServer } from 'node:http';
import { loadConfig } from './config';
import { db } from './db';
import { logger } from './logger';

const config = loadConfig();
const MAX_ROWS = 500;

export async function handle(path: string, limit = 50): Promise<Response> {
	if (path === '/health') {
		return new Response('ok', { headers: { 'cache-control': 'no-store' } });
	}
	const take = Math.min(limit, MAX_ROWS);
	const rows = await db.query('select * from orders order by created_at desc limit $1', [take]);
	logger.info({ path, count: rows.length }, 'served orders');
	return Response.json({ rows, take });
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', \`http://\${req.headers.host}\`);
	const response = await handle(url.pathname, Number(url.searchParams.get('limit') ?? 50));
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(await response.text());
}).listen(config.port, () => logger.info(\`listening on :\${config.port}\`));
`;

const PACKAGE = `{
	"name": "acme-api",
	"version": "0.4.0",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "tsx watch src/server.ts",
		"build": "tsc -p .",
		"test": "vitest run"
	},
	"dependencies": {
		"pg": "^8.13.1",
		"pino": "^9.5.0"
	}
}
`;

const README_HEAD = `# acme-api

Orders service for the Acme storefront.

## Running locally

\`\`\`sh
pnpm install
pnpm dev
\`\`\`
`;

const README_WORKING = `# acme-api

Orders service for the Acme storefront. Serves the most recent orders and a
health check for the load balancer.

## Running locally

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

## Endpoints

- \`GET /health\` returns **ok**, never cached
- \`GET /orders?limit=50\` returns at most *500* rows
`;

const SEED = `import os
import random
from datetime import datetime, timedelta

import psycopg

STATUSES = ("pending", "paid", "shipped", "refunded")


def seed(count: int = 200) -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        now = datetime.utcnow()
        for i in range(count):
            created = now - timedelta(minutes=random.randint(0, 60 * 24 * 30))
            conn.execute(
                "insert into orders (status, total_cents, created_at) values (%s, %s, %s)",
                (random.choice(STATUSES), random.randint(500, 25000), created),
            )
        print(f"seeded {count} orders")


if __name__ == "__main__":
    seed()
`;

const WORKER_HEAD = `package main

import (
	"context"
	"log"
	"time"
)

func main() {
	ctx := context.Background()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		if err := sweep(ctx); err != nil {
			log.Printf("sweep failed: %v", err)
		}
	}
}

func sweep(ctx context.Context) error {
	return nil
}
`;

const WORKER_WORKING = `package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := sweep(ctx); err != nil {
				slog.Error("sweep failed", "err", err)
			}
		}
	}
}

func sweep(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return expireStaleOrders(ctx)
}
`;

export const SAMPLES: Record<string, Sample> = {
	[`${ROOT}/src/server.ts`]: { head: SERVER_HEAD, working: SERVER_WORKING },
	[`${ROOT}/package.json`]: { head: PACKAGE, working: PACKAGE },
	[`${ROOT}/README.md`]: { head: README_HEAD, working: README_WORKING },
	[`${ROOT}/scripts/seed.py`]: { head: null, working: SEED },
	[`${ROOT}/cmd/worker/main.go`]: { head: WORKER_HEAD, working: WORKER_WORKING }
};

export function memoryFs(latency = 120): EditorFs & { writes: string[] } {
	const files = new Map(Object.entries(SAMPLES).map(([path, s]) => [path, { ...s }]));
	const wait = () => new Promise((resolve) => setTimeout(resolve, latency));
	const writes: string[] = [];
	return {
		writes,
		async readFile(path, opts) {
			await wait();
			const file = files.get(path);
			if (!file) throw new Error(`${path} does not exist`);
			if (opts?.ref) {
				if (file.head === null) throw new Error(`${path} is new in the working tree`);
				return file.head;
			}
			return file.working;
		},
		async writeFile(path, content) {
			await wait();
			const file = files.get(path);
			if (file) file.working = content;
			else files.set(path, { head: null, working: content });
			writes.push(path);
		}
	};
}
