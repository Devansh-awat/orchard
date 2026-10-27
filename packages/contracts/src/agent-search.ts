export interface AgentParam {
  name: string;
  required: boolean;
  schema: unknown;
}

export interface AgentOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  scope: 'read' | 'deploy' | 'exec';
  params?: { path?: AgentParam[]; query?: AgentParam[] };
  requestBody?: unknown;
  response?: unknown;
  'x-orchard-sensitive'?: boolean;
  'x-orchard-destructive'?: boolean;
}

export interface AgentSpec {
  version: string;
  operations: AgentOperation[];
}

export interface AgentSearchHit {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  score: number;
  sensitive?: boolean;
  destructive?: boolean;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'for',
  'and',
  'or',
  'in',
  'on',
  'my',
  'me',
  'i',
  'is',
  'it',
  'by',
  'with',
  'from',
  'all',
  'how',
  'what',
  'which',
  'do'
]);

const SYNONYMS: Record<string, string[]> = {
  app: ['deployment'],
  service: ['deployment', 'service'],
  db: ['database'],
  postgres: ['database'],
  domain: ['ingress'],
  url: ['ingress'],
  hostname: ['ingress'],
  secret: ['env', 'secret'],
  variable: ['env'],
  var: ['env'],
  environment: ['environment', 'env'],
  crash: ['rollout', 'killed', 'error'],
  crashing: ['rollout', 'killed', 'error'],
  broken: ['rollout', 'error'],
  live: ['rollout', 'live'],
  add: ['create'],
  new: ['create'],
  remove: ['delete'],
  show: ['get'],
  change: ['update', 'set'],
  edit: ['update', 'set'],
  restart: ['restart'],
  redeploy: ['rebuild', 'redeploy'],
  deploy: ['deployment', 'deploy'],
  cron: ['job'],
  schedule: ['schedule', 'job'],
  log: ['log'],
  credential: ['credential', 'connection'],
  password: ['password', 'connection'],
  connection: ['connection'],
  status: ['status', 'rollout'],
  rollout: ['rollout'],
  team: ['organization', 'member'],
  org: ['organization'],
  user: ['user', 'member']
};

const SYNONYM_WEIGHT = 0.9;
const DENSITY_WEIGHT = 0.5;

const FIELD_WEIGHTS = {
  operationId: 3,
  path: 2.5,
  summary: 2,
  tags: 1.5
} as const;

function stem(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('sses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !/(ss|us)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .map(stem);
}

function staticPathText(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment && !segment.startsWith(':') && !segment.startsWith('{'))
    .join(' ');
}

interface IndexedOperation {
  operation: AgentOperation;
  fields: [keyof typeof FIELD_WEIGHTS, Set<string>][];
}

function indexOperation(operation: AgentOperation): IndexedOperation {
  return {
    operation,
    fields: [
      ['operationId', new Set(tokenize(operation.operationId))],
      ['path', new Set(tokenize(staticPathText(operation.path)))],
      ['summary', new Set(tokenize(operation.summary))],
      ['tags', new Set(operation.tags.flatMap(tokenize))]
    ]
  };
}

function termWeight(term: string, indexed: IndexedOperation): number {
  let best = 0;
  for (const [field, tokens] of indexed.fields) {
    const weight = FIELD_WEIGHTS[field];
    if (tokens.has(term)) {
      best = Math.max(best, weight);
      continue;
    }
    if (term.length < 3) continue;
    for (const token of tokens) {
      if (token.length >= 3 && (token.startsWith(term) || term.startsWith(token))) {
        best = Math.max(best, weight / 2);
        break;
      }
    }
  }
  return best;
}

function expand(token: string): string[] {
  return [token, ...(SYNONYMS[token] ?? []).map(stem)];
}

export function scoreOperation(query: string, operation: AgentOperation): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const indexed = indexOperation(operation);
  const idTokens = indexed.fields[0][1];
  const hitIdTokens = new Set<string>();
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    let best = 0;
    for (const [index, candidate] of expand(term).entries()) {
      const weight = termWeight(candidate, indexed) * (index === 0 ? 1 : SYNONYM_WEIGHT);
      best = Math.max(best, weight);
      if (idTokens.has(candidate)) hitIdTokens.add(candidate);
    }
    if (best > 0) matched += 1;
    total += best;
  }
  if (matched === 0) return 0;
  const coverage = matched / terms.length;
  const density = idTokens.size ? hitIdTokens.size / idTokens.size : 0;
  const depth = operation.path.split('/').filter(Boolean).length;
  const score = total * coverage + density * DENSITY_WEIGHT - depth * 0.01;
  return Math.round(score * 1000) / 1000;
}

export function searchOperations(
  operations: AgentOperation[],
  query: string,
  limit = 10
): AgentSearchHit[] {
  const hits: AgentSearchHit[] = [];
  for (const operation of operations) {
    const score = scoreOperation(query, operation);
    if (score <= 0) continue;
    const hit: AgentSearchHit = {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      score
    };
    if (operation['x-orchard-sensitive']) hit.sensitive = true;
    if (operation['x-orchard-destructive']) hit.destructive = true;
    hits.push(hit);
  }
  hits.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.operationId.localeCompare(b.operationId)
  );
  return hits.slice(0, Math.max(1, limit));
}

function matchesTemplate(template: string, concrete: string): boolean {
  const left = template.split('/').filter(Boolean);
  const right = concrete.split('/').filter(Boolean);
  if (left.length !== right.length) return false;
  return left.every(
    (segment, index) =>
      segment.startsWith(':') || segment.startsWith('{') || segment === right[index]
  );
}

export function findOperation(
  operations: AgentOperation[],
  reference: string
): AgentOperation | undefined {
  const trimmed = reference.trim();
  const byId = operations.find((operation) => operation.operationId === trimmed);
  if (byId) return byId;
  const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(trimmed);
  if (!match) return undefined;
  const method = match[1].toUpperCase();
  const path = match[2].split('?')[0].replace(/\/+$/, '') || '/';
  const sameMethod = operations.filter((operation) => operation.method === method);
  const exact = sameMethod.find((operation) => operation.path === path);
  if (exact) return exact;
  const staticCount = (template: string) =>
    template.split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('{')).length;
  return sameMethod
    .filter((operation) => matchesTemplate(operation.path, path))
    .sort((a, b) => staticCount(b.path) - staticCount(a.path))[0];
}
