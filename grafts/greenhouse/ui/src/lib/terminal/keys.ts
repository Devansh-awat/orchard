export interface KeyHandlerDeps {
  onKeyDown?: (event: KeyboardEvent) => void;
  onClear: () => void;
  onZoom: (step: 1 | -1 | 0) => void;
  onInput?: (data: string) => void;
  optionIsMeta?: () => boolean;
}

const META_PUNCTUATION: Record<string, [plain: string, shifted: string]> = {
  Period: ['.', '>'],
  Comma: [',', '<'],
  Slash: ['/', '?'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backquote: ['`', '~'],
  Backslash: ['\\', '|']
};

export function optionMetaSequence(event: KeyboardEvent): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) return `\x1b${event.shiftKey ? letter[1] : letter[1].toLowerCase()}`;
  const digit = /^Digit(\d)$/.exec(event.code);
  if (digit && !event.shiftKey) return `\x1b${digit[1]}`;
  const punct = META_PUNCTUATION[event.code];
  if (punct) return `\x1b${punct[event.shiftKey ? 1 : 0]}`;
  return null;
}

export type KeyAction = 'pass' | 'native' | 'handled';

export function routeKey(event: KeyboardEvent, deps: KeyHandlerDeps): KeyAction {
  if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.code === 'KeyV') {
    return 'native';
  }

  if (deps.onInput && deps.optionIsMeta?.()) {
    const seq = optionMetaSequence(event);
    if (seq) {
      deps.onInput(seq);
      return 'handled';
    }
  }

  if (event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyK') {
    deps.onClear();
    return 'handled';
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      deps.onZoom(1);
      return 'handled';
    }
    if (!event.shiftKey && (event.code === 'Minus' || event.code === 'NumpadSubtract')) {
      deps.onZoom(-1);
      return 'handled';
    }
    if (!event.shiftKey && (event.code === 'Digit0' || event.code === 'Numpad0')) {
      deps.onZoom(0);
      return 'handled';
    }
  }

  return 'pass';
}

export function attachKeyHandler(host: HTMLElement, deps: KeyHandlerDeps): () => void {
  const listener = (event: KeyboardEvent) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    deps.onKeyDown?.(event);
    const action = routeKey(event, deps);
    if (action === 'pass') return;
    event.stopPropagation();
    if (action === 'handled') event.preventDefault();
  };
  host.addEventListener('keydown', listener, true);
  return () => host.removeEventListener('keydown', listener, true);
}
