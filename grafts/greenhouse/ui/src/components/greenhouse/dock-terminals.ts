import type { StoredTerminalTab, StoredTerminalTabs } from '../../lib/terminal/tabs-store';

export const DOCK_TERMINALS_KIND = 'sandbox';

const TERMINAL_RE = /^\d{1,2}$/;
const PANE_RE = /^(?:setup|run|run-[a-z0-9][a-z0-9-]{0,23}|term:\d{1,2}|watch:[0-9a-f-]{36})$/i;

export interface DockTerminals {
  terminals: Map<string, string[]>;
  handles: Map<string, string>;
}

export function dockPaneId(scope: string, pane: string): string {
  return `${scope}|${pane}`;
}

function splitPaneId(id: string): [scope: string, pane: string] | null {
  const at = id.indexOf('|');
  if (at <= 0) return null;
  return [id.slice(0, at), id.slice(at + 1)];
}

export function decodeDockTerminals(stored: StoredTerminalTabs | null): DockTerminals {
  const terminals = new Map<string, string[]>();
  const handles = new Map<string, string>();
  for (const tab of stored?.tabs ?? []) {
    const scope = tab.podName;
    const pane = tab.container;
    if (!scope || !PANE_RE.test(pane)) continue;
    if (pane.startsWith('term:')) {
      const n = pane.slice(5);
      const list = terminals.get(scope) ?? [];
      if (TERMINAL_RE.test(n) && !list.includes(n)) terminals.set(scope, [...list, n]);
    }
    if (tab.sessionHandle) handles.set(dockPaneId(scope, pane), tab.sessionHandle);
  }
  return { terminals, handles };
}

export function encodeDockTerminals(state: DockTerminals, current: string): StoredTerminalTabs {
  const tabs: StoredTerminalTab[] = [];
  const seen = new Set<string>();
  const push = (scope: string, pane: string) => {
    const id = dockPaneId(scope, pane);
    if (seen.has(id) || !PANE_RE.test(pane)) return;
    seen.add(id);
    const handle = state.handles.get(id);
    tabs.push({
      id,
      podName: scope,
      container: pane,
      label: pane,
      ...(handle ? { sessionHandle: handle } : {})
    });
  };
  const handleScopes = [...state.handles.keys()]
    .map(splitPaneId)
    .filter((p): p is [string, string] => p !== null);
  const scopes = new Set([
    current,
    ...state.terminals.keys(),
    ...handleScopes.map(([scope]) => scope)
  ]);
  for (const scope of scopes) {
    for (const n of state.terminals.get(scope) ?? []) push(scope, `term:${n}`);
    for (const [s, pane] of handleScopes) {
      if (s === scope && !pane.startsWith('term:')) push(s, pane);
    }
  }
  return { tabs, active: tabs[0]?.id ?? '', counter: tabs.length };
}
