import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  FolderTree,
  Globe,
  ListTodo,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-svelte';
import { fmtDuration, verbText } from './steps';

export { fmtDuration };

export const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Bash: SquareTerminal,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Patch: FilePen,
  Write: FilePlus,
  Read: FileText,
  Grep: Search,
  Glob: Search,
  List: FolderTree,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListTodo,
  TodoRead: ListTodo,
  Task: Bot
};

export function toolIcon(name: string): typeof Wrench {
  const known = TOOL_ICONS[name];
  if (known) return known;
  return name.includes('Search') ? Search : Wrench;
}

export function toolVerb(name: string, running: boolean): { icon: typeof Wrench; verb: string } {
  return { icon: toolIcon(name), verb: verbText(name, running) };
}

export function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function midTruncate(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) * 0.6);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return truncate(line, 90);
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function fmtCost(cost: number): string {
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

export function fmtClock(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
