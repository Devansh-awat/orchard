import type { SoundName } from 'cuelume';

export type ChatSize = 'sm' | 'md' | 'lg';
export type SendWith = 'enter' | 'mod-enter';
export type FollowUp = 'queue' | 'steer';
export type SoundChoice = SoundName | 'none';
export type SoundEvent = 'done' | 'attention' | 'error';
export type BranchPrefixMode = 'orchard' | 'github' | 'custom' | 'none';

export const ZOOM_STEPS = [0.9, 1, 1.1, 1.25] as const;
export const CHAT_SIZES: readonly ChatSize[] = ['sm', 'md', 'lg'];
export const CODE_MIN = 11;
export const CODE_MAX = 16;
export const SOUND_EVENTS: readonly SoundEvent[] = ['done', 'attention', 'error'];

const KEY = 'greenhouse.prefs.v1';

const READING: Record<ChatSize, { size: number; leading: number }> = {
  sm: { size: 13, leading: 20 },
  md: { size: 14, leading: 24 },
  lg: { size: 15, leading: 24 }
};

export interface PrefValues {
  zoom: number;
  chatSize: ChatSize;
  codeSize: number;
  monoFont: string;
  ligatures: boolean;
  terminalFont: string;
  sendWith: SendWith;
  followUp: FollowUp;
  autoAcceptPermissions: boolean;
  notifyAgent: boolean;
  sounds: Record<SoundEvent, SoundChoice>;
  notAbsolutelyRight: boolean;
  alwaysShowContext: boolean;
  showMcpStatus: boolean;
  expandTools: boolean;
  showReasoning: boolean;
  coloredDiffs: boolean;
  branchPrefixMode: BranchPrefixMode;
  branchPrefixCustom: string;
  deleteBranchOnArchive: boolean;
}

export const PREF_DEFAULTS: PrefValues = {
  zoom: 1,
  chatSize: 'md',
  codeSize: 13,
  monoFont: '',
  ligatures: true,
  terminalFont: '',
  sendWith: 'enter',
  followUp: 'queue',
  autoAcceptPermissions: false,
  notifyAgent: false,
  sounds: { done: 'success', attention: 'arrival', error: 'error' },
  notAbsolutelyRight: false,
  alwaysShowContext: false,
  showMcpStatus: true,
  expandTools: false,
  showReasoning: true,
  coloredDiffs: true,
  branchPrefixMode: 'orchard',
  branchPrefixCustom: '',
  deleteBranchOnArchive: false
};

function cleanZoom(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return PREF_DEFAULTS.zoom;
  return ZOOM_STEPS.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best));
}

function cleanCode(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return PREF_DEFAULTS.codeSize;
  return Math.max(CODE_MIN, Math.min(CODE_MAX, Math.round(n)));
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value: unknown, max = 80): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sound(value: unknown, fallback: SoundChoice): SoundChoice {
  return typeof value === 'string' && value.length > 0 && value.length < 32
    ? (value as SoundChoice)
    : fallback;
}

function clean(raw: Record<string, unknown>): PrefValues {
  const d = PREF_DEFAULTS;
  const sounds = (raw.sounds && typeof raw.sounds === 'object' ? raw.sounds : {}) as Record<
    string,
    unknown
  >;
  return {
    zoom: cleanZoom(raw.zoom ?? d.zoom),
    chatSize: oneOf(raw.chatSize, CHAT_SIZES, d.chatSize),
    codeSize: cleanCode(raw.codeSize ?? d.codeSize),
    monoFont: text(raw.monoFont),
    ligatures: bool(raw.ligatures, d.ligatures),
    terminalFont: text(raw.terminalFont),
    sendWith: oneOf(raw.sendWith, ['enter', 'mod-enter'] as const, d.sendWith),
    followUp: oneOf(raw.followUp, ['queue', 'steer'] as const, d.followUp),
    autoAcceptPermissions: bool(raw.autoAcceptPermissions, d.autoAcceptPermissions),
    notifyAgent: bool(raw.notifyAgent, d.notifyAgent),
    sounds: {
      done: sound(sounds.done, d.sounds.done),
      attention: sound(sounds.attention, d.sounds.attention),
      error: sound(sounds.error, d.sounds.error)
    },
    notAbsolutelyRight: bool(raw.notAbsolutelyRight, d.notAbsolutelyRight),
    alwaysShowContext: bool(raw.alwaysShowContext, d.alwaysShowContext),
    showMcpStatus: bool(raw.showMcpStatus, d.showMcpStatus),
    expandTools: bool(raw.expandTools, d.expandTools),
    showReasoning: bool(raw.showReasoning, d.showReasoning),
    coloredDiffs: bool(raw.coloredDiffs, d.coloredDiffs),
    branchPrefixMode: oneOf(
      raw.branchPrefixMode,
      ['orchard', 'github', 'custom', 'none'] as const,
      d.branchPrefixMode
    ),
    branchPrefixCustom: text(raw.branchPrefixCustom, 40),
    deleteBranchOnArchive: bool(raw.deleteBranchOnArchive, d.deleteBranchOnArchive)
  };
}

function fontStack(name: string, fallback: string): string {
  const trimmed = name.trim().replace(/["\\;{}]/g, '');
  return trimmed ? `"${trimmed}", ${fallback}` : fallback;
}

class GreenhousePrefs {
  #v = $state<PrefValues>(clean({}));

  constructor() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(KEY);
      const saved = raw ? (JSON.parse(raw) as unknown) : null;
      if (saved && typeof saved === 'object') this.#v = clean(saved as Record<string, unknown>);
    } catch {
      return;
    }
  }

  get values(): Readonly<PrefValues> {
    return this.#v;
  }

  set<K extends keyof PrefValues>(key: K, value: PrefValues[K]) {
    this.#v = clean({ ...this.#v, [key]: value });
    this.#save();
  }

  setSound(event: SoundEvent, choice: SoundChoice) {
    this.set('sounds', { ...this.#v.sounds, [event]: choice });
  }

  get zoom() {
    return this.#v.zoom;
  }

  set zoom(value: number) {
    this.set('zoom', value);
  }

  get chatSize() {
    return this.#v.chatSize;
  }

  set chatSize(value: ChatSize) {
    this.set('chatSize', value);
  }

  get codeSize() {
    return this.#v.codeSize;
  }

  set codeSize(value: number) {
    this.set('codeSize', value);
  }

  monoStack(fallback: string): string {
    return fontStack(this.#v.monoFont, fallback);
  }

  terminalStack(fallback: string): string {
    return fontStack(this.#v.terminalFont || this.#v.monoFont, fallback);
  }

  get isDefault() {
    return JSON.stringify(this.#v) === JSON.stringify(clean({}));
  }

  get style() {
    const reading = READING[this.#v.chatSize];
    return [
      `--gh-reading:${reading.size / 16}rem`,
      `--gh-lh-reading:${reading.leading / 16}rem`,
      `--gh-code-size:${this.#v.codeSize}px`,
      `--gh-mono:${this.monoStack('var(--font-mono-terminal)')}`,
      `--gh-mono-features:'calt' ${this.#v.ligatures ? 1 : 0}`
    ].join('; ');
  }

  stepCode(step: 1 | -1 | 0) {
    this.codeSize = step === 0 ? PREF_DEFAULTS.codeSize : this.#v.codeSize + step;
  }

  reset() {
    this.#v = clean({});
    this.#save();
  }

  #save() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#v));
    } catch {
      return;
    }
  }
}

export const greenhousePrefs = new GreenhousePrefs();
