export type ShellAction =
  | 'toggle-left'
  | 'toggle-right'
  | 'toggle-dock'
  | 'new-session'
  | 'terminal'
  | 'changes'
  | 'save'
  | 'find-file'
  | 'settings'
  | 'toggle-tools';

export interface ShellKey {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

export interface KeyOrigin {
  terminal: boolean;
}

export function shellShortcut(event: ShellKey, origin: KeyOrigin): ShellAction | null {
  if (event.defaultPrevented) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  if (origin.terminal && !event.metaKey) return null;
  const { code, altKey: alt, shiftKey: shift } = event;
  if (code === 'KeyO') {
    return event.ctrlKey && !event.metaKey && !alt && !shift ? 'toggle-tools' : null;
  }
  switch (code) {
    case 'KeyS':
      return alt || shift ? null : 'save';
    case 'KeyB':
      if (shift) return null;
      return alt ? 'toggle-right' : 'toggle-left';
    case 'KeyJ':
      return alt || shift ? null : 'toggle-dock';
    case 'KeyN':
      return alt || shift ? null : 'new-session';
    case 'KeyP':
      return alt || shift ? null : 'find-file';
    case 'Backquote':
      return alt ? null : 'terminal';
    case 'KeyG':
      return shift && !alt ? 'changes' : null;
    case 'Comma':
      return alt || shift ? null : 'settings';
    default:
      return null;
  }
}
