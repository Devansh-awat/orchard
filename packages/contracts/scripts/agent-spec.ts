import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_SCOPES,
  isAgentVisible,
  isDestructiveOperation,
  isSensitiveOperation
} from '../src/agent-flags';
import { assignOperationIds } from '../src/operation-ids';
import { registry } from '../src/registry';
import type { AgentOperation, AgentParam, AgentSpec } from '../src/agent-search';

type Json = Record<string, unknown>;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openapi = JSON.parse(readFileSync(resolve(packageRoot, 'openapi.json'), 'utf8')) as Json;
const outputPath = resolve(packageRoot, 'agent-spec.json');

const components = ((openapi.components as Json | undefined)?.schemas ?? {}) as Record<
  string,
  Json
>;

function resolveRefs(value: unknown, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, seen));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Json;
  const ref = record.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    const name = ref.slice('#/components/schemas/'.length);
    if (seen.has(name) || !components[name]) return { type: 'object' };
    return resolveRefs(components[name], new Set([...seen, name]));
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, resolveRefs(entry, seen)])
  );
}

function isGeneric(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const record = schema as Json;
  const properties = record.properties as Json | undefined;
  return (
    record.type === 'object' &&
    (!properties || Object.keys(properties).length === 0) &&
    !record.anyOf &&
    !record.oneOf &&
    !record.allOf
  );
}

function jsonSchemaOf(content: unknown): unknown {
  return ((content as Json | undefined)?.['application/json'] as Json | undefined)?.schema;
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function scopeFor(method: string, explicit?: string): AgentOperation['scope'] {
  if (explicit === 'read' || explicit === 'deploy' || explicit === 'exec') return explicit;
  return method === 'GET' ? 'read' : 'deploy';
}

const operationIds = assignOperationIds(registry);
const paths = openapi.paths as Record<string, Record<string, Json>>;
const operations: AgentOperation[] = [];

for (const route of registry) {
  if (!isAgentVisible(route)) continue;
  const doc = paths[toOpenApiPath(route.path)]?.[route.method.toLowerCase()];
  if (!doc) continue;

  const parameters = (resolveRefs(doc.parameters ?? []) as Json[]).filter(Boolean);
  const pathParams: AgentParam[] = [];
  const queryParams: AgentParam[] = [];
  for (const parameter of parameters) {
    const entry: AgentParam = {
      name: String(parameter.name),
      required: parameter.required === true,
      schema: (parameter.schema as Json | undefined) ?? { type: 'string' }
    };
    if (parameter.in === 'path') pathParams.push(entry);
    else if (parameter.in === 'query') queryParams.push(entry);
  }

  const requestBody = resolveRefs(jsonSchemaOf((doc.requestBody as Json | undefined)?.content));
  const response = resolveRefs(
    jsonSchemaOf(((doc.responses as Json | undefined)?.['200'] as Json | undefined)?.content)
  );

  const operation: AgentOperation = {
    operationId: operationIds.get(`${route.method} ${route.path}`)!,
    method: route.method,
    path: route.path,
    summary: route.summary ?? '',
    tags: (doc.tags as string[] | undefined) ?? [],
    scope: scopeFor(
      route.method,
      REQUIRED_SCOPES.get(`${route.method} ${route.path}`) ?? route.scope
    )
  };
  if (pathParams.length || queryParams.length) {
    operation.params = {};
    if (pathParams.length) operation.params.path = pathParams;
    if (queryParams.length) operation.params.query = queryParams;
  }
  if (['POST', 'PUT', 'PATCH'].includes(route.method)) {
    operation.requestBody = isGeneric(requestBody) ? { type: 'object' } : requestBody;
  }
  if (!isGeneric(response)) operation.response = response;
  if (isSensitiveOperation(route.method, route.path)) operation['x-orchard-sensitive'] = true;
  if (isDestructiveOperation(route.method, route.path)) operation['x-orchard-destructive'] = true;
  operations.push(operation);
}

operations.sort((a, b) => a.operationId.localeCompare(b.operationId));

const body = JSON.stringify(operations);
const spec: AgentSpec = {
  version: createHash('sha256').update(body).digest('hex').slice(0, 16),
  operations
};
const json = `${JSON.stringify(spec)}\n`;
writeFileSync(outputPath, json);

console.log(
  `wrote ${outputPath}: ${operations.length} operations, ${json.length} bytes (~${Math.round(json.length / 4)} tokens)`
);
