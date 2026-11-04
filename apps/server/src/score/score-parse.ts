import { load as loadYaml } from 'js-yaml';

export const SCORE_FILES = ['score.yaml', 'score.yml'] as const;
export const SCORE_API_VERSION = 'score.dev/v1b1';

const ANNOTATION_PREFIX = 'orchard.my/';
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE =
  /\$\{\s*resources\.([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;

export type ScoreResourceType = 'postgres' | 'redis' | 'unsupported';

export interface ScoreResource {
  name: string;
  type: ScoreResourceType;
  rawType: string;
}

export interface ScorePort {
  name: string;
  port: number;
  targetPort: number;
  protocol: 'TCP' | 'UDP';
}

export interface ScoreEnv {
  key: string;
  value: string;
}

export interface ScorePlan {
  name: string;
  container: string;
  image: string | null;
  command: string[] | null;
  args: string[] | null;
  env: ScoreEnv[];
  ports: ScorePort[];
  resources: ScoreResource[];
  domain: string | null;
  replicas: number | null;
  healthPath: string | null;
  warnings: string[];
}

export interface ScoreSummary {
  file: string;
  name: string;
  ports: number[];
  resources: { name: string; type: ScoreResourceType }[];
  domain: string | null;
  warnings: string[];
}

/**
 * Score's postgres outputs (host, port, name, username, password) onto the
 * fields a binding exposes. Anything unknown is left as is so the reference
 * fails loudly at inject time rather than resolving to a guess.
 */
const POSTGRES_FIELDS: Record<string, string> = {
  host: 'host',
  port: 'port',
  name: 'database',
  database: 'database',
  username: 'user',
  user: 'user',
  password: 'password',
  connection_string: 'connection_string',
  url: 'connection_string'
};

export function bindingNameForResource(resourceName: string): string {
  const base = resourceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (!base) return 'resource';
  return /^[a-z]/.test(base) ? base : `r_${base}`;
}

/** `${resources.db.host}` becomes `${{resource.db.host}}`, the live form. */
export function translatePlaceholders(
  value: string,
  resources: ScoreResource[]
): { value: string; unknown: string[] } {
  const unknown: string[] = [];
  const known = new Map(resources.map((r) => [r.name, r]));
  const out = value.replace(PLACEHOLDER_RE, (whole, res: string, field: string) => {
    const r = known.get(res);
    if (!r || r.type === 'unsupported') {
      unknown.push(`${res}.${field}`);
      return whole;
    }
    const mapped = r.type === 'postgres' ? (POSTGRES_FIELDS[field] ?? field) : field;
    return `\${{resource.${bindingNameForResource(res)}.${mapped}}}`;
  });
  return { value: out, unknown };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length ? out : null;
}

function port(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536 ? (n as number) : null;
}

/**
 * A Score workload, or null when the file is not one. Everything Score does
 * not model that Orchard needs lives under `metadata.annotations` with the
 * `orchard.my/` prefix, which is Score's own escape hatch. Unknown keys are
 * ignored and unknown resource types are kept so the caller can say so.
 */
export function parseScore(contents: string | null | undefined): ScorePlan | null {
  if (!contents) return null;
  let doc: any;
  try {
    doc = loadYaml(contents);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  if (doc.apiVersion !== SCORE_API_VERSION) return null;
  const name = str(doc.metadata?.name);
  if (!name || !NAME_RE.test(name)) return null;
  const containers = doc.containers && typeof doc.containers === 'object' ? doc.containers : null;
  if (!containers) return null;
  const containerNames = Object.keys(containers);
  if (containerNames.length === 0) return null;
  const warnings: string[] = [];
  if (containerNames.length > 1) {
    warnings.push(
      `Only the first container (${containerNames[0]}) is deployed; ${containerNames.length - 1} more ignored`
    );
  }
  const containerName = containerNames[0];
  const container = containers[containerName] ?? {};

  const resources: ScoreResource[] = [];
  const rawResources = doc.resources && typeof doc.resources === 'object' ? doc.resources : {};
  for (const [resName, spec] of Object.entries<any>(rawResources)) {
    const rawType = str(spec?.type) ?? '';
    const type: ScoreResourceType =
      rawType === 'postgres' || rawType === 'postgresql'
        ? 'postgres'
        : rawType === 'redis' || rawType === 'valkey'
          ? 'redis'
          : 'unsupported';
    if (type === 'unsupported' && rawType !== 'environment') {
      warnings.push(`Resource ${resName} of type ${rawType || 'unknown'} isn't provisioned`);
    }
    if (type === 'redis') warnings.push(`Resource ${resName}: managed Valkey isn't available yet`);
    resources.push({ name: resName, type, rawType });
  }

  const env: ScoreEnv[] = [];
  const variables =
    container.variables && typeof container.variables === 'object' ? container.variables : {};
  for (const [key, raw] of Object.entries<unknown>(variables)) {
    if (!ENV_KEY_RE.test(key)) {
      warnings.push(`Variable ${key} has an invalid name and was skipped`);
      continue;
    }
    const value = raw == null ? '' : String(raw);
    const { value: translated, unknown } = translatePlaceholders(value, resources);
    for (const u of unknown)
      warnings.push(`${key} references resources.${u}, which isn't provisioned`);
    env.push({ key, value: translated });
  }

  const ports: ScorePort[] = [];
  const rawPorts =
    doc.service?.ports && typeof doc.service.ports === 'object' ? doc.service.ports : {};
  for (const [portName, spec] of Object.entries<any>(rawPorts)) {
    const p = port(spec?.port);
    if (!p) {
      warnings.push(`Port ${portName} has no valid port and was skipped`);
      continue;
    }
    const target = port(spec?.targetPort) ?? p;
    const protocol = String(spec?.protocol || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    ports.push({ name: portName, port: p, targetPort: target, protocol });
  }

  const annotations =
    doc.metadata?.annotations && typeof doc.metadata.annotations === 'object'
      ? doc.metadata.annotations
      : {};
  const ann = (key: string): unknown => annotations[`${ANNOTATION_PREFIX}${key}`];
  const domain = str(ann('domain'));
  const replicasRaw = ann('replicas');
  const replicas =
    replicasRaw == null
      ? null
      : Number.isInteger(Number(replicasRaw)) && Number(replicasRaw) >= 0
        ? Number(replicasRaw)
        : null;
  if (replicasRaw != null && replicas === null) {
    warnings.push("orchard.my/replicas isn't a whole number and was ignored");
  }
  const healthPath = str(ann('health-path'));

  return {
    name,
    container: containerName,
    image: str(container.image) && container.image !== '.' ? str(container.image) : null,
    command: stringList(container.command),
    args: stringList(container.args),
    env,
    ports,
    resources,
    domain,
    replicas,
    healthPath,
    warnings
  };
}

export function summarize(file: string, plan: ScorePlan): ScoreSummary {
  return {
    file,
    name: plan.name,
    ports: plan.ports.map((p) => p.port),
    resources: plan.resources.map((r) => ({ name: r.name, type: r.type })),
    domain: plan.domain,
    warnings: plan.warnings
  };
}
