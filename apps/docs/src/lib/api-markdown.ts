import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SITE_URL } from './nav';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

interface Operation {
  method: string;
  path: string;
  id: string;
  slug: string;
  summary: string;
  description?: string;
  parameters: any[];
  requestBody?: any;
  responses?: Record<string, any>;
  tags: string[];
}

interface ApiDocument {
  info: { title: string; description?: string; version?: string };
  paths: Record<string, Record<string, any>>;
  components?: { parameters?: Record<string, any> };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

let cached: { doc: ApiDocument; operations: Operation[] } | undefined;

function load() {
  if (cached) return cached;
  const doc = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi.generated.json'), 'utf8')) as ApiDocument;
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const methods = METHODS.filter((method) => item[method]);
    const ids = methods.map((method) => item[method].operationId ?? path);
    methods.forEach((method, index) => {
      const operation = item[method];
      const id = ids[index];
      const duplicate = ids.filter((other) => other === id).length > 1;
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map((parameter: any) => {
        if (!parameter.$ref) return parameter;
        const name = String(parameter.$ref).split('/').pop() as string;
        return doc.components?.parameters?.[name] ?? parameter;
      });
      operations.push({
        method,
        path,
        id,
        slug: duplicate ? `operations/${slug(id)}/${method}` : `operations/${slug(id)}`,
        summary: operation.summary ?? id,
        description: operation.description,
        parameters,
        requestBody: operation.requestBody,
        responses: operation.responses,
        tags: operation.tags ?? ['Operations']
      });
    });
  }
  cached = { doc, operations };
  return cached;
}

export function apiOperations(): Operation[] {
  return load().operations;
}

export function apiTags(): string[] {
  return [...new Set(load().operations.flatMap((operation) => operation.tags))];
}

export function tagSlug(tag: string): string {
  return slug(tag);
}

function hasShape(schema: any): boolean {
  return Boolean(schema) && !(schema.type === 'object' && Object.keys(schema.properties ?? {}).length === 0);
}

export function apiOperationMarkdown(operation: Operation): string {
  const parts = [
    `# ${operation.summary}`,
    '',
    `Source: ${SITE_URL}/api/${operation.slug}/`,
    '',
    `\`${operation.method.toUpperCase()} /apiv1${operation.path}\``,
    '',
    `Operation ID: \`${operation.id}\``,
    ''
  ];
  if (operation.description) parts.push(operation.description, '');
  if (operation.parameters.length) {
    parts.push('## Parameters', '', '| Name | In | Required | Description |', '| --- | --- | --- | --- |');
    for (const parameter of operation.parameters) {
      const description = String(parameter.description ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      parts.push(
        `| \`${parameter.name}\` | ${parameter.in} | ${parameter.required ? 'Yes' : 'No'} | ${description} |`
      );
    }
    parts.push('');
  }
  const body = operation.requestBody?.content?.['application/json']?.schema;
  if (hasShape(body)) {
    parts.push('## Request body', '', '```json', JSON.stringify(body, null, 2), '```', '');
  }
  const responses = Object.entries(operation.responses ?? {});
  if (responses.length) {
    parts.push('## Responses', '');
    for (const [status, response] of responses) {
      parts.push(`### ${status}${response.description ? `: ${response.description}` : ''}`, '');
      const schema = response.content?.['application/json']?.schema;
      if (hasShape(schema)) parts.push('```json', JSON.stringify(schema, null, 2), '```', '');
    }
  }
  return parts.join('\n');
}

export function apiTagMarkdown(tag: string): string {
  const parts = [`# ${tag}`, '', `Source: ${SITE_URL}/api/operations/tags/${slug(tag)}/`, ''];
  for (const operation of load().operations.filter((item) => item.tags.includes(tag))) {
    parts.push(`- [${operation.summary}](${SITE_URL}/api/${operation.slug}.md)`);
  }
  parts.push('');
  return parts.join('\n');
}

export function apiOverviewMarkdown(): string {
  const { doc } = load();
  const parts = [
    `# ${doc.info.title}`,
    '',
    `Source: ${SITE_URL}/api/`,
    '',
    'Each Orchard instance serves this API under `/apiv1`. The instance also serves `/apiv1/openapi.json` and `/apiv1/agent-spec.json`.',
    '',
    '## Tags',
    ''
  ];
  for (const tag of apiTags()) {
    parts.push(`- [${tag}](${SITE_URL}/api/operations/tags/${slug(tag)}.md)`);
  }
  parts.push('');
  return parts.join('\n');
}
