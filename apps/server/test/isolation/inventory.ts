import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  classifyController,
  isController,
  type ClassifiedRoute,
  type RouteClassification
} from '../../src/auth/route-classifier';

const ROUTE_ARGS_METADATA = '__routeArguments__';
const ARG_BODY = 3;
const ARG_QUERY = 4;

const SRC_ROOT = path.resolve(__dirname, '../../src');
const GRAFTS_ROOT = path.resolve(__dirname, '../../../../grafts');

export const SNAPSHOT_PATH = path.resolve(__dirname, '../auth-coverage.snapshot.json');
export const MATRIX_PATH = path.resolve(__dirname, 'isolation-matrix.json');

export type IsolationClass =
  | 'public'
  | 'own-scope-only'
  | 'resource-scoped'
  | 'superadmin'
  | 'exempt'
  | 'unclassified';

export const ISOLATION_CLASSES: readonly IsolationClass[] = [
  'public',
  'own-scope-only',
  'resource-scoped',
  'superadmin',
  'exempt',
  'unclassified'
];

export type ParamRef = { name: string; kind: string };

export type InventoryRoute = {
  key: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  graft: string | null;
  auth: RouteClassification;
  pathParams: ParamRef[];
  queryParams: string[];
  hasBody: boolean;
  bodyIds: string[];
  file: string;
};

const NAME_KIND: Record<string, string> = {
  orgId: 'org',
  organizationId: 'org',
  orgSlug: 'orgSlug',
  projectId: 'project',
  projectSlug: 'projectSlug',
  deploymentId: 'deployment',
  ingressId: 'ingress',
  serviceId: 'service',
  portId: 'servicePort',
  connectionId: 'gitConnection',
  channelId: 'notificationChannel',
  memberId: 'orgMember',
  invitationId: 'invitation',
  podName: 'pod',
  pod: 'pod',
  domainId: 'orgDomain',
  pageId: 'statusPage',
  groupId: 'checkpointGroup',
  entryId: 'killedContainer',
  imageHistoryId: 'imageHistory',
  bindingId: 'binding',
  releaseId: 'release',
  destinationId: 'notificationDestination',
  opId: 'databaseOperation',
  namespace: 'namespace',
  slug: 'slug',
  subdomain: 'subdomain',
  fingerprint: 'errorFingerprint',
  scopeType: 'scopeType',
  scopeId: 'scopeId',
  owner: 'githubOwner',
  repo: 'githubRepo',
  provider: 'provider',
  token: 'publicToken',
  order: 'stepOrder',
  providerId: 'ssoProvider',
  ruleId: 'rule',
  runId: 'run',
  userId: 'user',
  itemId: 'item',
  loginId: 'login',
  replyId: 'reply',
  chatId: 'chat',
  linkId: 'link',
  cid: 'conversation',
  sid: 'session',
  name: 'name'
};

const SEGMENT_KIND: Record<string, string> = {
  organizations: 'org',
  organization: 'org',
  orgs: 'org',
  projects: 'project',
  deployments: 'deployment',
  deployment: 'deployment',
  databases: 'database',
  sessions: 'session',
  environments: 'environment',
  jobs: 'job',
  'compose-stacks': 'composeStack',
  'template-instances': 'templateInstance',
  templates: 'template',
  passkeys: 'passkey',
  links: 'accountLink',
  tokens: 'apiToken',
  checkpoints: 'databaseCheckpoint',
  'registry-credentials': 'registryCredential',
  'project-transfers': 'projectTransfer',
  ingresses: 'ingress',
  'deleted-databases': 'deletedDatabase',
  'ssh-identities': 'sshIdentity',
  sandboxes: 'sandbox',
  threads: 'thread'
};

const RULE_SEGMENT_KIND: Record<string, string> = {
  'metric-alerts': 'metricAlertRule',
  'notification-rules': 'notificationRule'
};

const RUN_SEGMENT_KIND: Record<string, string> = {
  'job-runs': 'jobRun',
  'build-runs': 'buildRun'
};

const TOKEN_SEGMENT_KIND: Record<string, string> = {
  'webhook-tokens': 'webhookToken',
  tokens: 'apiToken'
};

const USER_SEGMENT_KIND: Record<string, string> = {
  members: 'user',
  users: 'user'
};

export function paramKind(segments: string[], index: number): string {
  const name = segments[index].slice(1);
  const prev = index > 0 ? segments[index - 1] : '';
  const root = segments[0] ?? '';
  if (name === 'memberId') return root === 'projects' ? 'projectMember' : 'orgMember';
  if (name === 'invitationId') return root === 'projects' ? 'projectInvitation' : 'orgInvitation';
  if (name === 'token' && prev === 'invitations') return 'invitationToken';
  if (prev === 'by-id') return 'orgInvitation';
  if (prev === 'registry-credentials') {
    return root === 'organizations' ? 'orgRegistryCredential' : 'registryCredential';
  }
  if (name === 'slug' && root === 'organizations') return 'orgSlug';
  if (name === 'slug' && root === 'projects') return 'projectSlug';
  if (name === 'ruleId') return RULE_SEGMENT_KIND[prev] ?? 'rule';
  if (name === 'runId') return RUN_SEGMENT_KIND[prev] ?? 'run';
  if (name === 'tokenId') {
    if (prev === 'tokens' && root === 'organizations') return 'scimToken';
    return TOKEN_SEGMENT_KIND[prev] ?? 'apiToken';
  }
  if (name === 'userId') return USER_SEGMENT_KIND[prev] ?? 'user';
  if (name === 'id' || name === 'cid' || name === 'sid' || name === 'name') {
    const bySegment = SEGMENT_KIND[prev];
    if (bySegment) return bySegment;
  }
  if (name === 'cid' && prev === 'agent-chats') return 'agentChat';
  if (name === 'itemId') return 'contextItem';
  return NAME_KIND[name] ?? 'unknown';
}

const ID_FIELD = /(Id|Ids)$|^namespace$/;

const sourceCache = new Map<string, ts.SourceFile>();

function parseFile(file: string): ts.SourceFile | null {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  if (!existsSync(file)) return null;
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  );
  sourceCache.set(file, parsed);
  return parsed;
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function typeMembers(node: ts.TypeNode | undefined, source: ts.SourceFile, depth = 0): string[] {
  if (!node || depth > 3) return [];
  const names: string[] = [];
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name) names.push(member.name.getText(source));
    }
  } else if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const part of node.types) names.push(...typeMembers(part, source, depth + 1));
  } else if (ts.isParenthesizedTypeNode(node)) {
    names.push(...typeMembers(node.type, source, depth + 1));
  } else if (ts.isTypeReferenceNode(node)) {
    names.push(...referencedMembers(node.typeName.getText(source), source, depth + 1));
  }
  return names;
}

function referencedMembers(typeName: string, source: ts.SourceFile, depth: number): string[] {
  const names: string[] = [];
  const visit = (file: ts.SourceFile) => {
    for (const stmt of file.statements) {
      if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === typeName) {
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.name) names.push(member.name.getText(file));
        }
      } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === typeName) {
        names.push(...typeMembers(stmt.type, file, depth + 1));
      } else if (ts.isClassDeclaration(stmt) && stmt.name?.text === typeName) {
        for (const member of stmt.members) {
          if (ts.isPropertyDeclaration(member) && member.name) {
            names.push(member.name.getText(file));
          }
        }
      }
    }
  };
  visit(source);
  if (names.length === 0) {
    for (const stmt of source.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause?.namedBindings) continue;
      const bindings = stmt.importClause.namedBindings;
      if (!ts.isNamedImports(bindings)) continue;
      if (!bindings.elements.some((element) => element.name.text === typeName)) continue;
      const target = resolveImport(
        source.fileName,
        (stmt.moduleSpecifier as ts.StringLiteral).text
      );
      const parsed = target ? parseFile(target) : null;
      if (parsed) visit(parsed);
    }
  }
  return names;
}

function decoratorNames(node: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((decorator) => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression) ? expression.expression.getText() : expression.getText();
  });
}

export function bodyIdFields(file: string, className: string, methodName: string): string[] {
  const source = parseFile(file);
  if (!source) return [];
  const found = new Set<string>();
  for (const stmt of source.statements) {
    if (!ts.isClassDeclaration(stmt) || stmt.name?.text !== className) continue;
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || member.name.getText(source) !== methodName) continue;
      const bodyParams = member.parameters.filter((param) =>
        decoratorNames(param).includes('Body')
      );
      for (const param of bodyParams) {
        for (const name of typeMembers(param.type, source)) found.add(name.replace(/['"?]/g, ''));
      }
      const bodyNames = new Set(
        bodyParams.map((param) => param.name.getText(source)).filter((name) => /^\w+$/.test(name))
      );
      const visit = (node: ts.Node) => {
        if (
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          ts.isIdentifier(node.expression) &&
          bodyNames.has(node.expression.text)
        ) {
          const accessed = ts.isPropertyAccessExpression(node)
            ? node.name.text
            : ts.isStringLiteral(node.argumentExpression)
              ? node.argumentExpression.text
              : '';
          if (accessed) found.add(accessed);
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          bodyNames.has(node.initializer.text)
        ) {
          for (const element of node.name.elements) {
            found.add((element.propertyName ?? element.name).getText());
          }
        }
        ts.forEachChild(node, visit);
      };
      if (member.body) visit(member.body);
    }
  }
  return [...found].filter((name) => ID_FIELD.test(name)).sort();
}

function findControllerFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(p);
      } else if (entry.name.endsWith('.controller.ts')) {
        results.push(p);
      }
    }
  };
  walk(root);
  return results;
}

function controllerRoots(): { root: string; prefix: string; graft: string | null }[] {
  const roots: { root: string; prefix: string; graft: string | null }[] = [
    { root: SRC_ROOT, prefix: '', graft: null }
  ];
  if (!existsSync(GRAFTS_ROOT)) return roots;
  for (const entry of readdirSync(GRAFTS_ROOT, { withFileTypes: true })) {
    const serverSrc = path.join(GRAFTS_ROOT, entry.name, 'server', 'src');
    if (entry.isDirectory() && existsSync(serverSrc)) {
      roots.push({ root: serverSrc, prefix: entry.name, graft: entry.name });
    }
  }
  return roots;
}

function routeArguments(cls: Function, handler: string) {
  const meta = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, handler) ?? {}) as Record<
    string,
    { data?: unknown }
  >;
  const query = new Set<string>();
  let hasBody = false;
  for (const [key, value] of Object.entries(meta)) {
    const type = Number(key.split(':')[0]);
    if (type === ARG_BODY) hasBody = true;
    if (type === ARG_QUERY && typeof value.data === 'string') query.add(value.data);
    if (type === ARG_QUERY && typeof value.data !== 'string') query.add('*');
  }
  return { query: [...query].sort(), hasBody };
}

export async function buildInventory(): Promise<{
  routes: InventoryRoute[];
  conflicts: string[];
}> {
  const conflicts: string[] = [];
  const routes: InventoryRoute[] = [];
  for (const { root, prefix, graft } of controllerRoots()) {
    for (const file of findControllerFiles(root)) {
      const mod = await import(file);
      for (const exportName of Object.keys(mod)) {
        const cls = mod[exportName];
        if (!isController(cls)) continue;
        const classified: ClassifiedRoute[] = classifyController(cls, prefix, conflicts);
        for (const route of classified) {
          const handlerName = route.handler.split('.')[1];
          const segments = route.path.split('/').filter(Boolean);
          const pathParams: ParamRef[] = [];
          segments.forEach((segment, index) => {
            if (!segment.startsWith(':')) return;
            pathParams.push({ name: segment.slice(1), kind: paramKind(segments, index) });
          });
          const args = routeArguments(cls, handlerName);
          routes.push({
            key: route.key,
            method: route.method,
            path: route.path,
            controller: cls.name,
            handler: route.handler,
            graft,
            auth: route.classification,
            pathParams,
            queryParams: args.query,
            hasBody: args.hasBody,
            bodyIds: args.hasBody ? bodyIdFields(file, cls.name, handlerName) : [],
            file: path.relative(path.resolve(__dirname, '../../../..'), file)
          });
        }
      }
    }
  }
  const seen = new Map<string, InventoryRoute>();
  for (const route of routes) if (!seen.has(route.key)) seen.set(route.key, route);
  return {
    routes: [...seen.values()].sort((a, b) => a.key.localeCompare(b.key)),
    conflicts
  };
}

export function readSnapshot(): Record<string, RouteClassification> {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
}
