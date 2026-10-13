import { ocEffortLabel, ocIsFast, ocModelLabel, ocSearchModels } from '../opencode';
import type { ChatSessionStore } from './session-store.svelte';
import {
  bestOption,
  exportFileName,
  initPrompt,
  pickEffort,
  reviewPrompt,
  transcriptMarkdown,
  type SlashCommand,
  type SlashNotice,
  type SlashOption
} from './slash-commands';

export type ChatCommandUi = {
  help(): void;
  model(): void;
  context(): void;
  mcp(): void;
};

export type ChatCommandRun = {
  store: ChatSessionStore;
  command: SlashCommand;
  args: string;
  options: SlashOption[];
  ui: ChatCommandUi;
};

const BUSY: SlashNotice = { text: 'Wait for the agent to finish, or /stop it' };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportChat(store: ChatSessionStore, title?: string | null) {
  const name = title?.trim() || store.activeSession?.title || 'Chat';
  download(exportFileName(name), transcriptMarkdown(name, store.active?.entries ?? []));
}

function serverCommand(store: ChatSessionStore, name: string, args: string): SlashNotice | null {
  if (store.busy) return BUSY;
  void store.runCommand(name, args);
  return null;
}

export async function runChatCommand(run: ChatCommandRun): Promise<SlashNotice | null | undefined> {
  const { store, command, args, ui } = run;
  if (command.source === 'server') return serverCommand(store, command.name, args);
  switch (command.name) {
    case 'help':
      ui.help();
      return null;
    case 'model': {
      if (!args) {
        ui.model();
        return null;
      }
      const model = ocSearchModels(store.models, args)[0];
      if (!model) return { text: `No model matches "${args}"` };
      store.pickModel(model);
      return { text: `Using ${ocModelLabel(model)}` };
    }
    case 'effort': {
      if (store.variants.length === 0) return { text: 'This model has no effort levels' };
      const variant = pickEffort(store.variants, args);
      if (variant === undefined) {
        return { text: `Effort is one of default, ${store.variants.join(', ')}` };
      }
      store.pickVariant(variant);
      return { text: `Effort set to ${variant ? ocEffortLabel(variant) : 'default'}` };
    }
    case 'fast': {
      if (!store.fastSibling) return { text: 'This model has no fast mode' };
      store.toggleFast();
      return { text: store.model && ocIsFast(store.model) ? 'Fast mode on' : 'Fast mode off' };
    }
    case 'plan':
      store.setPlan(true);
      return { text: 'Plan mode on, the agent will not edit' };
    case 'build':
      store.setAgent(null);
      return { text: 'Plan mode off, the agent can edit' };
    case 'agents': {
      const pick = args ? bestOption(run.options, args) : null;
      if (!pick) {
        const names = run.options.map((o) => o.value).join(', ');
        return { text: names ? `Agents: ${names}` : 'No agents found' };
      }
      store.setAgent(pick.value);
      return { text: `The ${pick.value} agent answers next` };
    }
    case 'context':
      ui.context();
      return null;
    case 'mcp':
      ui.mcp();
      return null;
    case 'stop':
      if (!store.busy) return { text: 'The agent is not working' };
      await store.abort();
      return null;
    case 'compact':
      if (store.busy) return BUSY;
      if (!store.canCompact()) return { text: 'Nothing to compact yet' };
      void store.compact();
      return { text: 'Compacting the chat' };
    case 'undo':
      if (store.busy) return BUSY;
      if (!store.canUndo()) return { text: 'Nothing to undo' };
      if (!(await store.undoLast())) return null;
      return { text: 'Rolled back the last prompt, /redo brings it back' };
    case 'redo':
      if (!store.active?.revertedMessageID) return { text: 'Nothing to redo' };
      await store.unrevert();
      return null;
    case 'todos': {
      const todos = await store.todos();
      if (todos === null) return { text: 'Could not load the todo list' };
      if (todos.length === 0) return { text: 'No todos in this chat yet' };
      return { text: 'Todos', todos };
    }
    case 'export':
      exportChat(store);
      return null;
    case 'init':
      await store.sendText(initPrompt());
      return null;
    case 'review':
      await store.sendText(reviewPrompt(args));
      return null;
    default:
      return undefined;
  }
}
