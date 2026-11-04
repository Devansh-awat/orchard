import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_URL } from './nav';

export type ChangeType = 'Feature' | 'Fix';

export interface Change {
  id: string;
  date: string;
  type: ChangeType;
  component: string;
  componentSlug: string;
  text: string;
  detail?: string;
  version?: string;
  url?: string;
}

const SOURCES: Array<[string, string]> = [
  ['apps/server', 'Server'],
  ['apps/frontend', 'Dashboard'],
  ['apps/cli', 'CLI'],
  ['apps/registry', 'Registry'],
  ['apps/gateway', 'Gateway'],
  ['apps/r2-proxy', 'Backups'],
  ['apps/fc-builder', 'Builds'],
  ['grafts/greenhouse', 'Greenhouse'],
  ['grafts/forum', 'The Grove'],
  ['grafts/announcements', 'Announcements']
];

const SCOPES: Record<string, string> = {
  api: 'Server',
  auth: 'Server',
  builder: 'Builds',
  chart: 'Install',
  cli: 'CLI',
  compose: 'Server',
  databases: 'Server',
  deployments: 'Server',
  'fc-builder': 'Builds',
  forum: 'The Grove',
  frontend: 'Dashboard',
  github: 'Server',
  hostctl: 'Install',
  install: 'Install',
  mcp: 'MCP',
  network: 'Server',
  quotas: 'Server',
  'r2-proxy': 'Backups',
  server: 'Server',
  setup: 'Install',
  ui: 'Dashboard'
};

const NOISE =
  /\b(bump(s|ed)?|typecheck|oxlint|lint|flaky|snapshots?|playwright|smoke test|ci|cli parity|route parity|dependabot|prettier|oxfmt|format docs|commitlint|release-please|publish workflow|lockfile|tsconfig|moduleref|circular dep|mock|test_database_url|tests? no longer|lazy import|unused imports?|computehealth|packages\/health|buildqueue=|seed script|alpine|posthog|primitive|hackclubid|jwt claim|legacy|clerk|cleanup|dedupes?|redis|victoriametrics|apiserver|contributor docs|dev compose|first chunk|release builds|modulo|swatch(es)?|descenders|equal heights|tidy|hug|filler copy|agentd|kata|informer|apply queue|registration race|repository layout|rename transition)\b/i;

const CODE_LIKE = /\b[a-z]+[A-Z][a-zA-Z]*\b|\b[A-Z][a-z]+[A-Z][a-zA-Z]*\b|\w+\/[A-Z]\w+/;

const PROPER_NAMES: Record<string, string> = {
  api: 'API',
  apis: 'APIs',
  cli: 'CLI',
  cpu: 'CPU',
  cve: 'CVE',
  cves: 'CVEs',
  discord: 'Discord',
  dns: 'DNS',
  docker: 'Docker',
  dockerfile: 'Dockerfile',
  dockerfiles: 'Dockerfiles',
  firecracker: 'Firecracker',
  github: 'GitHub',
  gitlab: 'GitLab',
  harbor: 'Harbor',
  helm: 'Helm',
  http: 'HTTP',
  https: 'HTTPS',
  json: 'JSON',
  kubernetes: 'Kubernetes',
  mcp: 'MCP',
  oauth: 'OAuth',
  oidc: 'OIDC',
  otp: 'OTP',
  postgres: 'PostgreSQL',
  saml: 'SAML',
  scim: 'SCIM',
  slack: 'Slack',
  ssh: 'SSH',
  sso: 'SSO',
  tailscale: 'Tailscale',
  tls: 'TLS',
  trivy: 'Trivy',
  ui: 'UI',
  url: 'URL',
  urls: 'URLs',
  vercel: 'Vercel',
  yaml: 'YAML'
};

const NOISE_SCOPES = new Set(['ci', 'deps', 'test', 'tests', 'docs', 'chore']);

function repoRoot(): string {
  return resolve(process.cwd(), '../..');
}

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function clean(text: string): string {
  const trimmed = text
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .replace(/\b[a-z][a-z0-9]*\b/g, (word, index: number, text: string) => {
      if (text[index - 1] === '-' || text[index - 1] === '/' || text[index - 1] === '.')
        return word;
      const next = text[index + word.length];
      if (next === '-' || next === '/' || next === '.') return word;
      return PROPER_NAMES[word] ?? word;
    })
    .trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function readReleaseChanges(): Change[] {
  const root = repoRoot();
  const byHash = new Map<
    string,
    {
      date: string;
      type: ChangeType;
      scope?: string;
      text: string;
      versions: Map<string, string>;
      url: string;
      labels: string[];
    }
  >();

  for (const [dir, label] of SOURCES) {
    const file = join(root, dir, 'CHANGELOG.md');
    if (!existsSync(file)) continue;
    let date = '';
    let version = '';
    let section = '';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const release = line.match(/^#{1,3} \[?(\d+\.\d+\.\d+)\]?.*\((\d{4}-\d{2}-\d{2})\)/);
      if (release) {
        version = release[1];
        date = release[2];
        continue;
      }
      const heading = line.match(/^### (.+)/);
      if (heading) {
        section = heading[1];
        continue;
      }
      const item = line.match(
        /^\* (?:\*\*([\w-]+):\*\* )?(.*) \(\[([0-9a-f]{7,})\]\((https:[^)]+)\)\)\s*$/
      );
      if (!item || !date) continue;
      const [, scope, text, hash, url] = item;
      const type: ChangeType = section.startsWith('Features') ? 'Feature' : 'Fix';
      const existing = byHash.get(hash);
      if (existing) {
        existing.labels.push(label);
        existing.versions.set(label, version);
        if (date < existing.date) existing.date = date;
      } else {
        byHash.set(hash, {
          date,
          type,
          scope,
          text,
          versions: new Map([[label, version]]),
          url,
          labels: [label]
        });
      }
    }
  }

  const changes: Change[] = [];
  for (const [hash, item] of byHash) {
    if (item.scope && NOISE_SCOPES.has(item.scope)) continue;
    if (NOISE.test(item.text) || CODE_LIKE.test(item.text)) continue;
    const fromScope = item.scope ? SCOPES[item.scope] : undefined;
    const component = fromScope ?? (item.labels.length > 1 ? 'Platform' : item.labels[0]);
    const versionLabel = item.versions.has(component) ? component : item.labels[0];
    changes.push({
      id: `c-${hash}`,
      date: item.date,
      type: item.type,
      component,
      componentSlug: slugify(component),
      text: clean(item.text),
      version: `${versionLabel} ${item.versions.get(versionLabel)}`,
      url: item.url
    });
  }
  return changes;
}

function readUiNotes(): Change[] {
  const dir = join(repoRoot(), 'releases/ui/notes');
  if (!existsSync(dir)) return [];
  const notes: Change[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const raw = readFileSync(join(dir, name), 'utf8');
    const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const field = (key: string) =>
      frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1]?.trim();
    const title = field('title');
    const date = field('date');
    if (!title || !date) continue;
    const version = name.replace(/\.md$/, '');
    notes.push({
      id: `ui-${slugify(version)}`,
      date,
      type: 'Feature',
      component: 'Dashboard',
      componentSlug: 'dashboard',
      text: title,
      detail: field('summary'),
      version: `UI ${version}`,
      url: `${REPO_URL}/blob/main/releases/ui/notes/${name}`
    });
  }
  return notes;
}

let memo: Change[] | undefined;

export function getChanges(): Change[] {
  memo ??= [...readReleaseChanges(), ...readUiNotes()].sort(
    (a, b) =>
      b.date.localeCompare(a.date) || (a.type === b.type ? 0 : a.type === 'Feature' ? -1 : 1)
  );
  return memo;
}

export const PAGE_SIZE = 40;

export function getComponents(): Array<{ label: string; slug: string; count: number }> {
  const counts = new Map<string, { label: string; slug: string; count: number }>();
  for (const change of getChanges()) {
    const found = counts.get(change.componentSlug);
    if (found) found.count += 1;
    else
      counts.set(change.componentSlug, {
        label: change.component,
        slug: change.componentSlug,
        count: 1
      });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function changeHref(change: Change): string {
  const index = getChanges().indexOf(change);
  const page = Math.floor(index / PAGE_SIZE) + 1;
  return `${page === 1 ? '/changelog/' : `/changelog/page/${page}/`}#${change.id}`;
}

export function getFeatured(count: number): Change[] {
  return getChanges()
    .filter(
      (change) =>
        change.type === 'Feature' &&
        change.component !== 'Install' &&
        change.text.length >= 24 &&
        change.text.length <= 110 &&
        !/^(restyle|redesign)/i.test(change.text) &&
        !/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(change.text)
    )
    .slice(0, count);
}

export function formatDate(date: string, withYear = true, pad = true): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: pad ? '2-digit' : 'numeric',
    timeZone: 'UTC',
    ...(withYear ? { year: 'numeric' } : {})
  });
}

export function groupByDate(changes: Change[]): Array<{ date: string; changes: Change[] }> {
  const groups: Array<{ date: string; changes: Change[] }> = [];
  for (const change of changes) {
    const last = groups.at(-1);
    if (last?.date === change.date) last.changes.push(change);
    else groups.push({ date: change.date, changes: [change] });
  }
  return groups;
}
