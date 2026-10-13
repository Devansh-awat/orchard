export type SendWith = 'enter' | 'mod-enter';
export type FollowUp = 'queue' | 'steer';
export type SendIntent = 'send' | 'alternate' | null;

export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

export function sendIntent(event: ComposerKey, sendWith: SendWith): SendIntent {
  if (event.key !== 'Enter' || event.isComposing || event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (sendWith === 'enter') {
    if (mod) return 'alternate';
    return event.shiftKey ? null : 'send';
  }
  if (!mod) return null;
  return event.shiftKey ? 'alternate' : 'send';
}

export function followUpFor(intent: Exclude<SendIntent, null>, preferred: FollowUp): FollowUp {
  if (intent === 'send') return preferred;
  return preferred === 'queue' ? 'steer' : 'queue';
}

export function sendChord(sendWith: SendWith, mod: string): string {
  return sendWith === 'enter' ? '↵' : `${mod}↵`;
}

export function alternateChord(sendWith: SendWith, mod: string): string {
  return sendWith === 'enter' ? `${mod}↵` : `${mod}⇧↵`;
}
