import { readFileSync } from 'fs';
import type { AgentSpec } from '../../agent-spec/agent-search';
import { findContractsFile } from '../../agent-spec/contracts-files';

const REMOTE_TTL_MS = 10 * 60 * 1000;

let local: AgentSpec | null | undefined;
let remote: { spec: AgentSpec; at: number; base: string } | null = null;

function readLocal(): AgentSpec | null {
  if (local !== undefined) return local;
  const file = findContractsFile('agent-spec.json');
  local = file ? (JSON.parse(readFileSync(file, 'utf8')) as AgentSpec) : null;
  return local;
}

export async function loadAgentSpec(apiBaseUrl: string): Promise<AgentSpec> {
  const bundled = readLocal();
  if (bundled) return bundled;
  if (remote && remote.base === apiBaseUrl && Date.now() - remote.at < REMOTE_TTL_MS) {
    return remote.spec;
  }
  const res = await fetch(`${apiBaseUrl}/apiv1/agent-spec.json`);
  if (!res.ok) throw new Error(`Could not load the Orchard agent spec (HTTP ${res.status})`);
  const spec = (await res.json()) as AgentSpec;
  remote = { spec, at: Date.now(), base: apiBaseUrl };
  return spec;
}

export function setAgentSpecForTests(spec: AgentSpec | null): void {
  local = spec;
  remote = null;
}
