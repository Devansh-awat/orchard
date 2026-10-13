import type { OcMessage } from '../opencode';

export const TRANSCRIPT_CAP = 120_000;

const TOOL_ARG_KEYS = ['command', 'filePath', 'file_path', 'path', 'pattern', 'url', 'description'];

function toolLine(tool: string, input: unknown): string {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const key = TOOL_ARG_KEYS.find((k) => typeof record[k] === 'string' && record[k]);
  const arg = key ? String(record[key]).replace(/\s+/g, ' ').trim() : '';
  const short = arg.length > 160 ? `${arg.slice(0, 159)}…` : arg;
  return short ? `- ${tool}: \`${short.replace(/`/g, "'")}\`` : `- ${tool}`;
}

export function transcriptMarkdown(title: string, messages: OcMessage[]): string {
  const blocks: string[] = [];
  for (const { info, parts } of messages) {
    const lines: string[] = [];
    for (const part of parts) {
      if (part.synthetic || part.ignored) continue;
      if (part.type === 'text' && part.text?.trim()) lines.push(part.text.trim());
      else if (part.type === 'tool' && info.role === 'assistant') {
        lines.push(toolLine(part.tool ?? 'tool', part.state?.input));
      } else if (part.type === 'file' && part.filename) {
        lines.push(`- Attached ${part.filename}`);
      }
    }
    if (lines.length === 0) continue;
    const who = info.role === 'user' ? 'User' : 'Assistant';
    const body = lines.reduce(
      (out, line, i) =>
        i === 0
          ? line
          : `${out}${line.startsWith('- ') && lines[i - 1].startsWith('- ') ? '\n' : '\n\n'}${line}`,
      ''
    );
    blocks.push(`## ${who}\n\n${body}`);
  }
  const head = `# Chat transcript: ${title.trim() || 'Untitled chat'}`;
  if (blocks.length === 0) return `${head}\n\nThis chat has no messages yet.\n`;
  let body = blocks.join('\n\n');
  if (body.length > TRANSCRIPT_CAP) {
    const cut = body.slice(body.length - TRANSCRIPT_CAP);
    const at = cut.indexOf('\n## ');
    body = `_Earlier messages trimmed._\n\n${at >= 0 ? cut.slice(at + 1) : cut}`;
  }
  return `${head}\n\n${body}\n`;
}

export function transcriptFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `chat-${slug || 'transcript'}.md`;
}
