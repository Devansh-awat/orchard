import type { TerminalThemeColors } from '@wterm/dom';

export type Rgba = [number, number, number, number];

export function readRgba(probe: HTMLElement, token: string): Rgba {
  probe.style.color = '';
  probe.style.color = `var(${token})`;
  const value = getComputedStyle(probe).color;
  const parts = value.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return [0, 0, 0, 1];
  const scale = value.startsWith('color(') ? 255 : 1;
  return [
    Number(parts[0]) * scale,
    Number(parts[1]) * scale,
    Number(parts[2]) * scale,
    parts[3] === undefined ? 1 : Number(parts[3])
  ];
}

function channel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function flatten(color: Rgba, backdrop: Rgba): number {
  const alpha = color[3];
  const mix = (i: number) => channel(color[i] * alpha + backdrop[i] * (1 - alpha));
  return (mix(0) << 16) | (mix(1) << 8) | mix(2);
}

export function hex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

const PALETTE_TOKENS = [
  '--bg-sunken',
  '--status-error',
  '--status-success',
  '--status-warning',
  '--hue-blue',
  '--hue-violet',
  '--hue-emerald',
  '--text-muted',
  '--text-faint',
  '--hue-red',
  '--hue-green',
  '--hue-amber',
  '--hue-blue',
  '--hue-pink',
  '--hue-emerald',
  '--text-default'
];

export interface TerminalThemeOpts {
  background?: string;
}

export function buildTerminalTheme(
  host: HTMLElement,
  opts: TerminalThemeOpts = {}
): TerminalThemeColors {
  const bgToken = opts.background ?? '--bg-app';
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const backdrop = readRgba(probe, bgToken);
  const pick = (token: string) => flatten(readRgba(probe, token), backdrop);
  const theme: TerminalThemeColors = {
    background: pick(bgToken),
    foreground: pick('--text-default'),
    cursor: pick('--accent'),
    palette: PALETTE_TOKENS.map(pick)
  };
  probe.remove();
  return theme;
}

export function watchTerminalTheme(
  host: HTMLElement,
  apply: (theme: TerminalThemeColors) => void,
  opts: TerminalThemeOpts = {}
): () => void {
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!host.isConnected) return;
      apply(buildTerminalTheme(host, opts));
    });
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class']
  });
  return () => observer.disconnect();
}
