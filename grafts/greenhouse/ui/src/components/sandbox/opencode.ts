import { apiFetch } from '../../host/stores';

export type OcSession = {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  revert?: { messageID: string; partID?: string };
  time: { created: number; updated: number; archived?: number };
};

export type OcToolState = {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type OcPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  callID?: string;
  state?: OcToolState;
  mime?: string;
  url?: string;
  filename?: string;
  time?: { start: number; end?: number };
};

export type OcAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
  isImage: boolean;
};

export type OcFilePart = {
  type: 'file';
  mime: string;
  filename: string;
  url: string;
};

export type OcTokens = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type OcMessageInfo = {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  cost?: number;
  providerID?: string;
  modelID?: string;
  variant?: string | null;
  agent?: string;
  tokens?: OcTokens | null;
  error?: OcError | null;
  time: { created: number; completed?: number };
};

export type OcError = { name?: string; data?: { message?: string } & Record<string, unknown> };

export type OcModel = {
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  context: number | null;
  variants: string[];
};

export type OcMcpState =
  | 'connected'
  | 'disabled'
  | 'failed'
  | 'needs_auth'
  | 'needs_client_registration';

export type OcMcpServer = { name: string; status: OcMcpState; error?: string };

export type OcMcpType = 'local' | 'remote';

export type OcMcpConfig =
  | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean };

export type OcMessage = { info: OcMessageInfo; parts: OcPart[] };

export type OcEvent = { type: string; properties?: Record<string, unknown> };

const OC_HOME = '/persist/home';

const OC_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  write: 'Write',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  list: 'List',
  patch: 'Patch',
  task: 'Task',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead'
};

const OC_INPUT_KEYS: Record<string, string> = {
  filePath: 'file_path',
  oldString: 'old_string',
  newString: 'new_string'
};

export function ocBase(sandboxId: string): string {
  return `/apiv1/sandboxes/${sandboxId}/opencode`;
}

export function ocDirectory(repo: string | null): string | null {
  return repo ? `${OC_HOME}/${repo}` : null;
}

export function ocRepo(directory: string): string | null {
  if (!directory || directory === OC_HOME) return null;
  return directory.split('/').pop() || null;
}

export async function ocProbe(sandboxId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`${ocBase(sandboxId)}/doc`, {
      signal: AbortSignal.timeout(8000)
    });
    res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export async function ocModels(sandboxId: string): Promise<OcModel[]> {
  const res = await apiFetch(`${ocBase(sandboxId)}/config/providers`);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    providers?: {
      id: string;
      name: string;
      models?: Record<
        string,
        {
          name?: string;
          limit?: { context?: number };
          variants?: Record<string, unknown> | null;
        }
      >;
    }[];
  };
  const models: OcModel[] = [];
  for (const provider of data.providers ?? []) {
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      models.push({
        providerID: provider.id,
        providerName: provider.name,
        modelID,
        name: model.name ?? modelID,
        context: model.limit?.context ?? null,
        variants: model.variants ? Object.keys(model.variants) : []
      });
    }
  }
  return models;
}

export async function ocList(
  sandboxId: string,
  path: 'command' | 'agent',
  directory: string | null
): Promise<unknown[]> {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const res = await apiFetch(`${ocBase(sandboxId)}/${path}${query}`);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as unknown;
  return Array.isArray(data) ? data : [];
}

export function ocShortModelName(name: string): string {
  return name.replace(/^Claude\s+/i, '').replace(/\s*\(latest\)$/i, '');
}

export type OcModelGroup = { name: string; models: OcModel[] };

const CLAUDE_FAMILIES = ['Opus', 'Sonnet', 'Fable', 'Haiku'];

const CLAUDE_NAME = /^(Opus|Sonnet|Fable|Haiku)\s+(\d+(?:\.\d+)*)(\s+Fast)?$/i;

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number(part) || 0);
}

function compareVersionsDesc(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isAlias(model: OcModel): boolean {
  return /\(latest\)\s*$/i.test(model.name) || !/-\d{8}$/.test(model.modelID);
}

function dedupe(models: OcModel[]): OcModel[] {
  const byName = new Map<string, OcModel>();
  for (const model of models) {
    const key = `${model.providerID}\u0000${ocShortModelName(model.name).toLowerCase()}`;
    const existing = byName.get(key);
    if (!existing || (isAlias(model) && !isAlias(existing))) byName.set(key, model);
  }
  return [...byName.values()];
}

export function ocModelGroups(models: OcModel[]): OcModelGroup[] {
  const claude = new Map<string, { model: OcModel; version: string; fast: boolean }[]>();
  const others = new Map<string, OcModel[]>();
  for (const model of dedupe(models)) {
    const match = ocShortModelName(model.name).match(CLAUDE_NAME);
    if (match) {
      const family =
        CLAUDE_FAMILIES.find((f) => f.toLowerCase() === match[1].toLowerCase()) ?? match[1];
      const list = claude.get(family) ?? [];
      list.push({ model, version: match[2], fast: !!match[3] });
      claude.set(family, list);
      continue;
    }
    const list = others.get(model.providerName) ?? [];
    list.push(model);
    others.set(model.providerName, list);
  }
  const groups: OcModelGroup[] = [];
  for (const family of CLAUDE_FAMILIES) {
    const list = claude.get(family);
    if (!list?.length) continue;
    list.sort(
      (a, b) => compareVersionsDesc(a.version, b.version) || Number(a.fast) - Number(b.fast)
    );
    groups.push({ name: family, models: list.map((entry) => entry.model) });
  }
  for (const [name, list] of [...others.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => ocShortModelName(a.name).localeCompare(ocShortModelName(b.name)));
    groups.push({ name, models: list });
  }
  return groups;
}

export function ocModelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

export type OcProviderKind = 'anthropic' | 'openai' | 'other';

export function ocProviderKind(model: OcModel): OcProviderKind {
  const provider = model.providerID.toLowerCase();
  if (
    provider.includes('anthropic') ||
    /claude/i.test(model.modelID) ||
    /^claude/i.test(model.name)
  )
    return 'anthropic';
  if (provider.includes('openai') || /^(gpt|o\d|codex)/i.test(model.modelID)) return 'openai';
  return 'other';
}

export function ocEffortLabel(variant: string | null): string {
  return variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : 'Default';
}

const FAST_SUFFIX = /\s+Fast$/i;

export function ocIsFast(model: OcModel): boolean {
  return FAST_SUFFIX.test(ocShortModelName(model.name));
}

export function ocModelLabel(model: OcModel): string {
  return ocShortModelName(model.name).replace(FAST_SUFFIX, '');
}

export function ocFastSibling(model: OcModel, models: OcModel[]): OcModel | null {
  const base = ocModelLabel(model).toLowerCase();
  const fast = ocIsFast(model);
  const matches = models.filter(
    (m) =>
      m.providerID === model.providerID &&
      m.modelID !== model.modelID &&
      ocIsFast(m) !== fast &&
      ocModelLabel(m).toLowerCase() === base
  );
  return matches.find(isAlias) ?? matches[0] ?? null;
}

export function ocDefaultFavourites(groups: OcModelGroup[]): OcModel[] {
  const claude = groups.filter((g) => CLAUDE_FAMILIES.includes(g.name));
  const source = claude.length > 0 ? claude : groups.slice(0, 3);
  const picks: OcModel[] = [];
  for (const group of source) {
    const newest = group.models.find((m) => !ocIsFast(m)) ?? group.models[0];
    if (newest) picks.push(newest);
  }
  return picks;
}

export function ocSearchModels(models: OcModel[], query: string): OcModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models;
  return models.filter((m) => {
    const haystack = `${ocShortModelName(m.name)} ${m.modelID} ${m.providerName}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

export function ocMcpServers(
  map: Record<string, { status: string; error?: string }>
): OcMcpServer[] {
  return Object.entries(map)
    .map(([name, s]) => ({ name, status: s.status as OcMcpState, error: s.error }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ocFmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export function ocNormalizeTool(tool: string, input: unknown): { name: string; input: unknown } {
  const name = OC_TOOL_NAMES[tool] ?? tool;
  if (!input || typeof input !== 'object') return { name, input };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[OC_INPUT_KEYS[key] ?? key] = value;
  }
  return { name, input: out };
}

export const OC_ATTACH_MAX_BYTES = 5 * 1024 * 1024;
export const OC_ATTACH_MAX_COUNT = 10;

export function ocIsImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

export function ocFmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ocReadAttachment(file: File): Promise<OcAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const mime = file.type || 'application/octet-stream';
      resolve({
        id: crypto.randomUUID(),
        name: file.name || 'attachment',
        mime,
        size: file.size,
        dataUrl: typeof reader.result === 'string' ? reader.result : '',
        isImage: ocIsImageMime(mime)
      });
    };
    reader.readAsDataURL(file);
  });
}

export function ocFilePart(attachment: OcAttachment): OcFilePart {
  return {
    type: 'file',
    mime: attachment.mime,
    filename: attachment.name,
    url: attachment.dataUrl
  };
}

export function ocPartAttachment(part: OcPart): OcAttachment | null {
  if (part.type !== 'file' || !part.url) return null;
  const mime = part.mime || 'application/octet-stream';
  return {
    id: part.id,
    name: part.filename || 'attachment',
    mime,
    size: 0,
    dataUrl: part.url,
    isImage: ocIsImageMime(mime)
  };
}

const OC_AUTH_HINT =
  /(api[ _-]?key|credential|unauthori[sz]ed|authenticat|oauth|401|403|not logged in|login|invalid x-api-key|token)/i;

export function ocIsAborted(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { name?: string }).name === 'MessageAbortedError'
  );
}

export function ocIsAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as OcError;
  if (e.name === 'ProviderAuthError') return true;
  return OC_AUTH_HINT.test(`${e.name ?? ''} ${e.data?.message ?? ''}`);
}

export function ocErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { name?: string; data?: { message?: string } };
    if (e.data?.message) return e.data.message;
    if (e.name) return e.name;
  }
  return 'The agent hit an error';
}

function ocMcpPath(sandboxId: string, path: string, directory: string | null): string {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return `${ocBase(sandboxId)}/mcp${path}${query}`;
}

async function ocMcpError(res: Response, fallback: string): Promise<Error> {
  if (res.status === 403) return new Error('Only the host can change MCP servers');
  const data = (await res.json().catch(() => null)) as {
    message?: string;
    error?: string;
    data?: { message?: string };
  } | null;
  return new Error(data?.data?.message ?? data?.message ?? data?.error ?? fallback);
}

export type OcMcpList = { servers: OcMcpServer[]; forbidden: boolean };

export async function ocMcpList(sandboxId: string, directory: string | null): Promise<OcMcpList> {
  const res = await apiFetch(ocMcpPath(sandboxId, '', directory));
  if (res.status === 403) return { servers: [], forbidden: true };
  if (!res.ok) throw await ocMcpError(res, 'Could not load MCP servers');
  const map = (await res.json()) as Record<string, { status: string; error?: string }>;
  return { servers: ocMcpServers(map ?? {}), forbidden: false };
}

export async function ocMcpTypes(
  sandboxId: string,
  directory: string | null
): Promise<Record<string, OcMcpType>> {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const res = await apiFetch(`${ocBase(sandboxId)}/config${query}`);
  if (!res.ok) return {};
  const config = (await res.json().catch(() => null)) as {
    mcp?: Record<string, { type?: string }>;
  } | null;
  const types: Record<string, OcMcpType> = {};
  for (const [name, entry] of Object.entries(config?.mcp ?? {})) {
    if (entry?.type === 'local' || entry?.type === 'remote') types[name] = entry.type;
  }
  return types;
}

export async function ocMcpAdd(
  sandboxId: string,
  directory: string | null,
  name: string,
  config: OcMcpConfig
): Promise<void> {
  const res = await apiFetch(ocMcpPath(sandboxId, '', directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config })
  });
  if (!res.ok) throw await ocMcpError(res, `Could not add ${name}`);
}

export async function ocMcpToggle(
  sandboxId: string,
  directory: string | null,
  name: string,
  action: 'connect' | 'disconnect'
): Promise<void> {
  const res = await apiFetch(
    ocMcpPath(sandboxId, `/${encodeURIComponent(name)}/${action}`, directory),
    { method: 'POST' }
  );
  if (!res.ok) throw await ocMcpError(res, `Could not ${action} ${name}`);
}

export async function ocMcpAuthStart(
  sandboxId: string,
  directory: string | null,
  name: string
): Promise<string> {
  const res = await apiFetch(ocMcpPath(sandboxId, `/${encodeURIComponent(name)}/auth`, directory), {
    method: 'POST'
  });
  if (!res.ok) throw await ocMcpError(res, `${name} does not support signing in from the browser`);
  const data = (await res.json().catch(() => null)) as { authorizationUrl?: string } | null;
  const url = data?.authorizationUrl;
  if (!url || !/^https?:\/\//i.test(url)) throw new Error(`${name} did not return a sign in page`);
  return url;
}

export async function ocMcpAuthFinish(
  sandboxId: string,
  directory: string | null,
  name: string,
  code: string
): Promise<void> {
  const res = await apiFetch(
    ocMcpPath(sandboxId, `/${encodeURIComponent(name)}/auth/callback`, directory),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    }
  );
  if (!res.ok) throw await ocMcpError(res, `Could not finish signing in to ${name}`);
}

export async function ocMcpAuthRemove(
  sandboxId: string,
  directory: string | null,
  name: string
): Promise<void> {
  const res = await apiFetch(ocMcpPath(sandboxId, `/${encodeURIComponent(name)}/auth`, directory), {
    method: 'DELETE'
  });
  if (!res.ok) throw await ocMcpError(res, `Could not sign out of ${name}`);
}

export function ocOauthCode(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.searchParams.get('code');
  } catch {
    return /^[\w.~-]+$/.test(text) ? text : null;
  }
}
