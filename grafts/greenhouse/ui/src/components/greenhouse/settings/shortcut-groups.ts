import { LOCAL_COMMANDS } from '../../sandbox/chat/slash-commands';
import type { FollowUp, SendWith } from '../prefs.svelte';

export interface ShortcutEntry {
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutEntry[];
}

export function commandItems(): ShortcutEntry[] {
  return LOCAL_COMMANDS.map((command) => {
    const aliases = (command.aliases ?? []).map((a) => `/${a}`);
    return {
      keys: [`/${command.name}`],
      label:
        aliases.length > 0
          ? `${command.description}, also ${aliases.join(' or ')}`
          : command.description
    };
  });
}

export function shortcutGroups(
  mac: boolean,
  sendWith: SendWith,
  followUp: FollowUp
): ShortcutGroup[] {
  const mod = mac ? '⌘' : 'Ctrl';
  const alt = mac ? '⌥' : 'Alt';
  const ctrl = mac ? '⌃' : 'Ctrl';
  const shift = '⇧';
  const send = sendWith === 'enter' ? ['↵'] : [mod, '↵'];
  const newline = sendWith === 'enter' ? [shift, '↵'] : ['↵'];
  const alternate = sendWith === 'enter' ? [mod, '↵'] : [mod, shift, '↵'];
  const other = followUp === 'queue' ? 'Steer instead of queueing' : 'Queue instead of steering';

  return [
    {
      title: 'General',
      items: [
        { keys: [mod, 'N'], label: 'New session in the current repository' },
        { keys: [mod, 'K'], label: 'Search sessions, files and commands' },
        { keys: [mod, 'B'], label: 'Show or hide the sidebar' },
        { keys: [mod, alt, 'B'], label: 'Show or hide the right panel' },
        { keys: [mod, shift, 'G'], label: 'Open the Changes tab' },
        { keys: [mod, ','], label: 'Open settings' }
      ]
    },
    {
      title: 'Chat',
      items: [
        { keys: send, label: 'Send the prompt' },
        { keys: alternate, label: other },
        { keys: newline, label: 'New line in the prompt' },
        { keys: ['Esc'], label: 'Stop the agent while it is working' },
        { keys: ['/', 'Tab'], label: 'Complete a command, ↑↓ to pick one' },
        { keys: [ctrl, 'O'], label: 'Expand or collapse tool calls' },
        { keys: [mod, shift, 'E'], label: 'Fast mode, when the model has one' },
        { keys: [mod, shift, '/'], label: 'Cycle reasoning effort' },
        {
          keys: mac ? ['⌃', '⌘', '1–9'] : ['Ctrl', 'Alt', '1–9'],
          label: 'Pick a favourite model'
        }
      ]
    },
    {
      title: 'Permission and question cards',
      items: [
        { keys: ['↵'], label: 'Allow, or submit the answer' },
        { keys: [mod, '↵'], label: 'Always allow' },
        { keys: ['Esc'], label: 'Deny, then ↵ to send' },
        { keys: ['1–9'], label: 'Pick an option' }
      ]
    },
    {
      title: 'Editor',
      items: [
        { keys: [mod, 'P'], label: 'Find a file' },
        { keys: [mod, 'S'], label: 'Save the open file' },
        { keys: [mod, 'F'], label: 'Find in the file' },
        { keys: [mod, '↵'], label: 'Commit in Changes, or post a diff comment' }
      ]
    },
    {
      title: 'Terminal',
      items: [
        { keys: [mod, '`'], label: 'Focus the terminal' },
        { keys: [mod, 'J'], label: 'Collapse or expand the dock' },
        { keys: [mod, '+'], label: 'Larger code size' },
        { keys: [mod, '−'], label: 'Smaller code size' },
        { keys: [mod, '0'], label: 'Reset code size' },
        ...(mac ? [{ keys: [mod, 'K'], label: 'Clear the terminal' }] : [])
      ]
    },
    {
      title: 'Commands',
      items: commandItems()
    }
  ];
}
