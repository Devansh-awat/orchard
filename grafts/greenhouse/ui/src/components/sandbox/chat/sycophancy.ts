const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

const OPENER =
  /([.!?]["'”’)]?[ \t]+|\n[ \t]*(?:(?:[-*+]|\d+[.)]|>)[ \t]+)?)(\*\*|__)?(?:you(?:['’]re| are) )?absolutely right(?:[ \t]*[!.,;:…—–-])+\2[ \t]*(\S?)/gi;

function capital(char: string): string {
  return char ? char.toUpperCase() : '';
}

function stripProse(text: string, first: boolean): string {
  const source = first ? `\n${text}` : text;
  const out = source.replace(OPENER, (_match, lead: string, _wrap: string, next: string) => {
    const boundary = lead.startsWith('\n') ? lead : lead.replace(/[ \t]+$/, ' ');
    return `${boundary}${capital(next)}`;
  });
  return first ? out.slice(1) : out;
}

export function stripSycophancy(text: string): string {
  if (!text || !/absolutely right/i.test(text)) return text;
  const joined = text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : stripProse(part, i === 0)))
    .join('');
  const result = /^\s/.test(text) ? joined : joined.replace(/^\s+/, '');
  return result.trim() ? result : text;
}
