import type { AgentOperation } from '../../agent-spec/agent-search';
import { OrchardApiError, query as toQuery, type McpScope, type QueryInput } from '../client';
import { SENSITIVE_META_KEY, scopeAllows } from '../catalog';

export const OUTPUT_CAP = 24_000;

export interface CallApiInput {
  operationId: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  fields?: string[];
  confirm?: string;
}

export interface RequestClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function fillPath(
  template: string,
  params: Record<string, string | number> = {}
): { path?: string; missing: string[]; invalid: string[] } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const filled = template.replace(/:([A-Za-z0-9_]+)|\{\*?([A-Za-z0-9_]+)\}/g, (_, a, b) => {
    const name = a ?? b;
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return `:${name}`;
    }
    const raw = String(value);
    if (raw === '.' || raw === '..') {
      invalid.push(name);
      return `:${name}`;
    }
    return encodeURIComponent(raw);
  });
  return missing.length || invalid.length
    ? { missing, invalid }
    : { path: filled, missing, invalid };
}

type FieldTree = { [key: string]: FieldTree | true };

function buildTree(fields: string[]): FieldTree {
  const tree: FieldTree = {};
  for (const field of fields) {
    const parts = field
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    let node = tree;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        node[part] = true;
        return;
      }
      const next = node[part];
      if (next === true) return;
      node[part] = next ?? {};
      node = node[part] as FieldTree;
    });
  }
  return tree;
}

function applyTree(value: unknown, tree: FieldTree): unknown {
  if (Array.isArray(value)) return value.map((entry) => applyTree(entry, tree));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(tree)) {
    if (!(key in source)) continue;
    out[key] = sub === true ? source[key] : applyTree(source[key], sub);
  }
  return out;
}

export function projectFields(value: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0) return value;
  const tree = buildTree(fields);
  if (Object.keys(tree).length === 0) return value;
  return applyTree(value, tree);
}

export function capOutput(text: string, max = OUTPUT_CAP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: the response is ${text.length} characters and only the first ${max} are shown. Call again with fields (e.g. ["items.id","items.status"]) or a narrower query to get just what you need.]`;
}

function toQueryInput(input?: Record<string, unknown>): QueryInput | undefined {
  if (!input) return undefined;
  const out: QueryInput = {};
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) out[key] = value.map((entry) => String(entry));
    else if (value !== undefined && value !== null) {
      out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }
  return out;
}

export function confirmationError(operation: AgentOperation): string {
  return `${operation.operationId} (${operation.method} ${operation.path}) is destructive. Ask the user first, then call again with confirm: "${operation.operationId}".`;
}

export async function executeCall(
  client: RequestClient,
  operation: AgentOperation,
  input: CallApiInput,
  scope: McpScope
): Promise<ToolResult> {
  if (operation['x-orchard-destructive'] && input.confirm !== operation.operationId) {
    return errorResult(confirmationError(operation));
  }
  if (!scopeAllows(scope, operation.scope)) {
    return errorResult(
      `${operation.operationId} needs the ${operation.scope} scope and this connection has ${scope}. Reconnect with the mcp:${operation.scope} scope or use an orch_ token that has it.`
    );
  }
  const filled = fillPath(operation.path, input.pathParams);
  if (filled.invalid.length) {
    return errorResult(`Path parameter(s) ${filled.invalid.join(', ')} cannot be "." or "..".`);
  }
  if (!filled.path) {
    return errorResult(
      `Missing path parameter(s) for ${operation.operationId}: ${filled.missing.join(', ')}. Pass them in pathParams.`
    );
  }
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method);
  try {
    const data = await client.request(
      operation.method,
      filled.path + toQuery(toQueryInput(input.query)),
      hasBody ? input.body : undefined
    );
    const projected = projectFields(data, input.fields);
    const text =
      projected === undefined
        ? JSON.stringify({ ok: true })
        : typeof projected === 'string'
          ? projected
          : JSON.stringify(projected);
    const result: ToolResult = { content: [{ type: 'text', text: capOutput(text) }] };
    if (operation['x-orchard-sensitive']) result._meta = { [SENSITIVE_META_KEY]: true };
    return result;
  } catch (err) {
    if (err instanceof OrchardApiError) {
      return errorResult(
        `HTTP ${err.status} from ${operation.method} ${filled.path}: ${err.detail}`
      );
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
