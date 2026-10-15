import type { OcProviderKind } from '../opencode';

export type AgentChoice = { value: string; name: string; group?: string };

export type AgentChoiceItem = { value: string; name: string; label: string; free: boolean };

export type AgentChoiceSection = { name: string; items: AgentChoiceItem[] };

const FREE_RE = /\s*[([]?free[)\]]?$/i;

export function agentProviderKind(agent: string): OcProviderKind {
  if (agent === 'claude') return 'anthropic';
  if (agent === 'codex') return 'openai';
  return 'other';
}

function split(name: string): { prefix: string; rest: string } {
  const slash = name.lastIndexOf('/');
  if (slash <= 0 || slash === name.length - 1) return { prefix: '', rest: name };
  return { prefix: name.slice(0, slash).trim(), rest: name.slice(slash + 1).trim() };
}

export function agentChoiceGroups(
  choices: AgentChoice[],
  agentLabel: string
): AgentChoiceSection[] {
  const sections = new Map<string, AgentChoiceItem[]>();
  for (const choice of choices) {
    const { prefix, rest } = split(choice.name);
    const free = FREE_RE.test(rest);
    const label = free ? rest.replace(FREE_RE, '') || rest : rest;
    let group = choice.group?.trim() || prefix;
    if (group.toLowerCase() === agentLabel.toLowerCase()) group = '';
    const list = sections.get(group) ?? [];
    list.push({ value: choice.value, name: choice.name, label, free });
    sections.set(group, list);
  }
  const out = [...sections].map(([name, items]) => ({ name, items }));
  if (out.length === 1) out[0] = { ...out[0], name: '' };
  return out;
}
