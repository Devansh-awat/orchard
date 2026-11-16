import { load } from 'js-yaml';

export const UNTRUSTED_YAML_MAX_NODES = 100_000;

export function loadUntrustedYaml(text: string, maxNodes = UNTRUSTED_YAML_MAX_NODES): unknown {
  const doc = load(text);
  const seen = new Set<object>();
  const stack: unknown[] = [doc];
  let nodes = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) throw new Error(`document has more than ${maxNodes} nodes`);
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) throw new Error('aliases to lists or maps are not allowed');
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) stack.push(child);
  }
  return doc;
}
