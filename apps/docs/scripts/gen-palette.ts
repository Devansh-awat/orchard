import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePalette } from '../../frontend/src/lib/theme/generate';
import { generateScales } from '../../frontend/src/lib/theme/scales';
import { presetById, type Scheme } from '../../frontend/src/lib/theme/spec';

const ACCENT = '#5173c5';
const spec = presetById('mono')!.spec;

const pins = {
  light: { accent: ACCENT },
  dark: {
    accent: ACCENT,
    background: '#0a0a0a',
    card: '#1a1a1a',
    sidebarBackground: '#171717',
    border: '#242424'
  }
};

const block = (selector: string, scheme: Scheme) =>
  [
    `${selector} {`,
    ...Object.entries(generateScales(spec, scheme, composePalette(spec, scheme, pins[scheme]))).map(
      ([key, value]) => `  ${key}: ${value};`
    ),
    '}'
  ].join('\n');

writeFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'palette.css'),
  [block(':root', 'light'), '', block(':root.dark', 'dark'), ''].join('\n')
);
