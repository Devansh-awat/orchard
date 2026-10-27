import type { IncomingMessage, ServerResponse } from 'node:http';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Ctx {
	method: Method;
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	body: any;
	req: IncomingMessage;
	res: ServerResponse;
}

export class Reply {
	constructor(
		readonly status: number,
		readonly body: unknown,
		readonly headers: Record<string, string> = {}
	) {}
}

export const STREAMING = Symbol('streaming');

export function reply(status: number, body: unknown, headers?: Record<string, string>) {
	return new Reply(status, body, headers);
}

export function notFound(message = 'Not found') {
	return reply(404, { statusCode: 404, message });
}

export function text(body: string, contentType = 'text/plain; charset=utf-8') {
	return reply(200, body, { 'content-type': contentType });
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
	method: Method;
	pattern: string;
	regex: RegExp;
	keys: string[];
	handler: Handler;
}

function compile(pattern: string) {
	const keys: string[] = [];
	const source = pattern
		.split('/')
		.map((segment) => {
			if (segment.startsWith(':')) {
				keys.push(segment.slice(1));
				return '([^/]+)';
			}
			if (segment === '*') {
				keys.push('rest');
				return '(.*)';
			}
			return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		})
		.join('/');
	return { regex: new RegExp(`^${source}/?$`), keys };
}

export class Router {
	private routes: Route[] = [];

	private add(method: Method, pattern: string, handler: Handler) {
		const { regex, keys } = compile(pattern);
		this.routes.push({ method, pattern, regex, keys, handler });
		return this;
	}

	get(pattern: string, handler: Handler) {
		return this.add('GET', pattern, handler);
	}

	post(pattern: string, handler: Handler) {
		return this.add('POST', pattern, handler);
	}

	patch(pattern: string, handler: Handler) {
		return this.add('PATCH', pattern, handler);
	}

	put(pattern: string, handler: Handler) {
		return this.add('PUT', pattern, handler);
	}

	delete(pattern: string, handler: Handler) {
		return this.add('DELETE', pattern, handler);
	}

	match(method: Method, path: string) {
		let best: { route: Route; m: RegExpExecArray } | null = null;
		for (const route of this.routes) {
			if (route.method !== method) continue;
			const m = route.regex.exec(path);
			if (m && (!best || route.keys.length < best.route.keys.length)) best = { route, m };
		}
		if (!best) return null;
		const { route, m } = best;
		const params: Record<string, string> = {};
		route.keys.forEach((key, i) => {
			params[key] = decodeURIComponent(m[i + 1] ?? '');
		});
		return { handler: route.handler, params };
	}
}
