export type ToolFile = { src: string; mime: string; name: string | null };

const TOOL_FILE_CAP = 4;
const TOOL_FILE_MAX_CHARS = 8_000_000;

export function toolFiles(
  items: Array<{ src: unknown; mime: unknown; name?: unknown }>
): ToolFile[] {
  const out: ToolFile[] = [];
  for (const item of items) {
    if (out.length >= TOOL_FILE_CAP) break;
    if (typeof item.src !== 'string' || typeof item.mime !== 'string') continue;
    if (!item.src.startsWith('data:') || item.src.length > TOOL_FILE_MAX_CHARS) continue;
    out.push({
      src: item.src,
      mime: item.mime,
      name: typeof item.name === 'string' && item.name ? item.name : null
    });
  }
  return out;
}
