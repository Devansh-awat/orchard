const ASIDE_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  caution: 'Caution',
  danger: 'Warning'
};

function attribute(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{\`([^\`]*)\`\\})`))?.slice(1).find(Boolean);
}

function quote(body: string, label: string): string {
  const lines = body.trim().split('\n');
  return [`> **${label}**`, '>', ...lines.map((line) => (line ? `> ${line}` : '>'))].join('\n');
}

function convertDiagrams(source: string): string {
  return source.replace(/<Diagram\b((?:[^`]|`[^`]*`)*?)\/>/g, (_, attrs: string) => {
    const code = attrs.match(/code=\{`([\s\S]*?)`\}/)?.[1]?.trim() ?? '';
    const caption = attribute(attrs, 'caption');
    return `\`\`\`mermaid\n${code}\n\`\`\`${caption ? `\n\n${caption}` : ''}`;
  });
}

function convertAsides(source: string): string {
  const output: string[] = [];
  const lines = source.split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) inFence = !inFence;
    const open = inFence ? null : line.match(/^(\s*):::(\w+)(?:\[([^\]]*)\])?\s*$/);
    if (!open) {
      output.push(line);
      continue;
    }
    const [, indent, type, title] = open;
    const body: string[] = [];
    let bodyFence = false;
    index += 1;
    while (index < lines.length) {
      if (/^\s*```/.test(lines[index])) bodyFence = !bodyFence;
      if (!bodyFence && /^\s*:::\s*$/.test(lines[index])) break;
      body.push(lines[index].startsWith(indent) ? lines[index].slice(indent.length) : lines[index]);
      index += 1;
    }
    const label = ASIDE_LABELS[type] ?? 'Note';
    output.push(
      ...quote(body.join('\n'), title ? `${label}: ${title}` : label)
        .split('\n')
        .map((quoted) => `${indent}${quoted}`)
    );
  }
  return output.join('\n');
}

function convertBlocks(text: string): string {
  return text
    .replace(/^\s*import\s[^\n]*from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+const\s[^\n]*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<Aside\b([^>]*)>([\s\S]*?)<\/Aside>/g, (_, attrs: string, body: string) => {
      const type = attribute(attrs, 'type') ?? 'note';
      const title = attribute(attrs, 'title');
      return quote(body, title ? `${ASIDE_LABELS[type] ?? 'Note'}: ${title}` : (ASIDE_LABELS[type] ?? 'Note'));
    })
    .replace(/<TabItem\b([^>]*)>/g, (_, attrs: string) => `\n**${attribute(attrs, 'label') ?? 'Tab'}**\n`)
    .replace(/<\/?Tabs\b[^>]*>|<\/TabItem>/g, '')
    .replace(/<LinkCard\b([^>]*)\/>/g, (_, attrs: string) => {
      const description = attribute(attrs, 'description');
      return `- [${attribute(attrs, 'title') ?? ''}](${attribute(attrs, 'href') ?? ''})${description ? `: ${description}` : ''}`;
    })
    .replace(/<Card\b([^>]*)>/g, (_, attrs: string) => `\n**${attribute(attrs, 'title') ?? ''}**\n`)
    .replace(/<\/Card>/g, '')
    .replace(/<Badge\b([^>]*)\/>/g, (_, attrs: string) => attribute(attrs, 'text') ?? '')
    .replace(/<\/?[A-Z][\w.]*\b[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}');
}

export function toPlainMarkdown(body: string | undefined): string {
  if (!body) return '';
  const source = convertAsides(convertDiagrams(body));
  const segments = source.split(/^([ \t>]*```[\s\S]*?^[ \t>]*```[ \t]*$)/m);
  const output = segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .split(/(`[^`\n]*`)/)
        .map((part, partIndex) => (partIndex % 2 === 1 ? part : convertBlocks(part)))
        .join('');
    })
    .join('');
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownResponse(text: string): Response {
  return new Response(text, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
  });
}
