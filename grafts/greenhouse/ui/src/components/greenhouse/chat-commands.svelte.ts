import { toasts } from '../../host/stores';
import {
  FEEDBACK_URL,
  LOCAL_COMMANDS,
  bestOption,
  effortOptions,
  mergeCommands,
  primaryAgents,
  securityReviewPrompt,
  serverCommands,
  visibleCommands,
  type AgentChoice,
  type SlashCommand,
  type SlashNotice,
  type SlashOption
} from '../sandbox/chat/index';
import { ocList } from '../sandbox/opencode';
import * as api from './api';
import type { GreenhouseApp } from './app.svelte';
import {
  LINK_GITHUB,
  VIEWER_ONLY,
  chatTabId,
  isLegacy,
  isPreparing,
  scopeOf,
  type MachineWorkspace
} from './workspace.svelte';

const MEMORY_FILES = ['AGENTS.md', 'CLAUDE.md'];
const NEW_MEMORY = 'AGENTS.md';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export class GreenhouseCommands {
  readonly ws: MachineWorkspace;
  readonly app: GreenhouseApp;

  server = $state.raw<SlashCommand[]>([]);
  agents = $state.raw<AgentChoice[]>([]);
  creating = $state<string | null>(null);

  #loadedFor: string | null = null;
  #seq = 0;

  constructor(ws: MachineWorkspace, app: GreenhouseApp) {
    this.ws = ws;
    this.app = app;
  }

  readonly list = $derived.by(() =>
    visibleCommands(mergeCommands(LOCAL_COMMANDS, this.server), this.ws.canEdit)
  );

  async load(directory: string | null, chatId: string | null) {
    const key = `${directory ?? ''}\n${chatId ?? ''}`;
    if (key === this.#loadedFor) return;
    this.#loadedFor = key;
    const seq = ++this.#seq;
    const sandboxId = this.ws.sandboxId;
    const [commands, agents] = await Promise.all([
      ocList(sandboxId, 'command', directory).catch(() => []),
      ocList(sandboxId, 'agent', directory).catch(() => [])
    ]);
    if (seq !== this.#seq) return;
    this.server = serverCommands(commands);
    this.agents = primaryAgents(agents);
  }

  options(command: SlashCommand): SlashOption[] {
    if (command.source === 'server') return [];
    const ws = this.ws;
    switch (command.name) {
      case 'effort':
        return ws.store.variants.length > 0 ? effortOptions(ws.store.variants) : [];
      case 'agents':
        return this.agents.map((a) => ({
          value: a.name,
          label: a.name,
          ...(a.description ? { description: a.description } : {})
        }));
      case 'resume':
        return ws.chatList
          .filter((c) => c.id !== ws.activeChatId)
          .map((c) => ({ value: c.id, label: c.title || 'Chat' }));
      default:
        return [];
    }
  }

  async run(
    command: SlashCommand,
    args: string,
    alias: string | null
  ): Promise<SlashNotice | null> {
    const ws = this.ws;
    const app = this.app;
    if (!ws.canEdit && !command.readonly) return { text: VIEWER_ONLY };
    switch (command.name) {
      case 'clear':
        if (!ws.running) return { text: 'Start the machine first' };
        await ws.newChat();
        return null;
      case 'resume': {
        const pick = bestOption(this.options(command), args);
        if (!pick) return { text: args ? `No chat matches "${args}"` : 'No other chats here' };
        ws.host.openTab(chatTabId(pick.value));
        return null;
      }
      case 'rename':
        return this.rename(args);
      case 'security-review':
        await ws.store.sendText(securityReviewPrompt(ws.session?.baseBranch ?? null));
        return null;
      case 'memory':
        return this.memory();
      case 'permissions':
        app.openSettings('preferences');
        return null;
      case 'settings':
        app.openSettings();
        return null;
      case 'terminal':
        app.onShell?.('terminal');
        return null;
      case 'diff':
        app.onShell?.('changes');
        return null;
      case 'pr':
        return this.pr();
      case 'status':
        return { text: this.status() };
      case 'share':
        app.sheet = 'share';
        return null;
      case 'bug':
        window.open(FEEDBACK_URL, '_blank', 'noopener');
        return null;
      default:
        return { text: `/${alias ?? command.name} isn't available here` };
    }
  }

  async rename(title: string): Promise<SlashNotice | null> {
    const ws = this.ws;
    const session = ws.session;
    if (!title) {
      this.app.onShell?.('rename');
      return null;
    }
    if (!session) return { text: 'Open a session first' };
    if (isLegacy(session)) {
      const chat = ws.store.activeId;
      if (chat) await ws.store.renameSession(chat, title);
    } else {
      await ws.renameSession(session, title);
    }
    return { text: `Renamed to ${title}` };
  }

  async memory(): Promise<SlashNotice | null> {
    const ws = this.ws;
    const session = ws.session;
    if (!session || isPreparing(session)) return { text: 'Open a session first' };
    const entries = await api.listDir(ws.sandboxId, session.worktreePath, '.');
    if (entries.length === 0) return { text: "Couldn't read the worktree" };
    for (const name of MEMORY_FILES) {
      if (entries.some((e) => e.type === 'file' && e.name === name)) {
        ws.openFile(name);
        return null;
      }
    }
    this.creating = NEW_MEMORY;
    return null;
  }

  async createMemory() {
    const ws = this.ws;
    const session = ws.session;
    const name = this.creating ?? NEW_MEMORY;
    this.creating = null;
    if (!session) return;
    try {
      await api.writeFile(ws.sandboxId, scopeOf(session), name, '');
      ws.openFile(name);
      void ws.refreshChanges(session.id);
    } catch (e) {
      toasts.add({
        title: `Couldn't create ${name}`,
        description: e instanceof Error ? e.message : undefined,
        color: 'error'
      });
    }
  }

  async pr(): Promise<SlashNotice | null> {
    const ws = this.ws;
    const session = ws.session;
    if (!session) return { text: 'Open a session first' };
    if (session.prUrl) {
      window.open(session.prUrl, '_blank', 'noopener');
      return null;
    }
    if (ws.githubLinked === false) return { text: LINK_GITHUB };
    if (!ws.canPush) return { text: "You can't push from this machine" };
    try {
      await ws.createPr(false);
    } catch (e) {
      ws.prFailed('Create PR', e);
    }
    return null;
  }

  status(): string {
    const ws = this.ws;
    const machine = ws.machine;
    const session = ws.session;
    const parts = [machine ? `${machine.name} is ${machine.status}` : 'No machine'];
    if (session) {
      parts.push(`on ${session.branch}`);
      const files = ws.changes.get(session.id)?.files.length ?? session.diffstat?.files ?? 0;
      parts.push(files > 0 ? plural(files, 'changed file') : 'no changes');
      const sync = session.aheadBehind;
      if (sync && (sync.ahead > 0 || sync.behind > 0)) {
        parts.push(`${sync.ahead} ahead, ${sync.behind} behind`);
      }
      if (session.prNumber) parts.push(`PR #${session.prNumber} ${session.prState ?? 'open'}`);
    }
    return parts.join(', ');
  }
}
