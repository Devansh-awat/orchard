import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchOperations, type AgentSpec } from '../src/agent-search';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(resolve(packageRoot, 'agent-spec.json'), 'utf8')) as AgentSpec;

const queries = [
  'restart deployment',
  'deployment logs',
  'database password',
  'is my app live',
  'crashing pods',
  'set env vars',
  'list deployments',
  'add domain',
  'run job',
  'rollback',
  'getDatabaseConnections',
  'the status of my app',
  'zebra'
];

const operations = spec.operations.map(({ operationId, method, path, summary, tags, scope }) => ({
  operationId,
  method,
  path,
  summary,
  tags,
  scope
}));

const cases = queries.map((query) => ({
  query,
  hits: searchOperations(operations, query, 8).map(({ operationId, score }) => ({
    operationId,
    score
  }))
}));

writeFileSync(
  resolve(packageRoot, 'test/fixtures/search-parity.json'),
  `${JSON.stringify({ operations, cases })}\n`
);
console.log(
  `wrote search parity fixture: ${operations.length} operations, ${cases.length} queries`
);
