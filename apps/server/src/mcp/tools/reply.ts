/**
 * Tool results are billed to the caller's context window, so they are
 * serialised compactly. Indenting a response costs 23% more tokens on a single
 * deployment and 34% on a listing, buying nothing: the model parses either form
 * the same, and nobody reads raw tool output.
 *
 * Every tool returns through here so that stays true as tools are added.
 */
export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** For results that are already prose or a raw log, not a structure. */
export function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function structured<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function failure(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export const TEXT_CAP = 20_000;

export function capText(value: string, max = TEXT_CAP): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const omitted = value.length - max;
  return {
    text: `[truncated: ${omitted} earlier characters omitted, showing the last ${max}]\n${value.slice(-max)}`,
    truncated: true
  };
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;

export function paginate<T>(
  items: T[] | null | undefined,
  options: { limit?: number; cursor?: string },
  defaultLimit = DEFAULT_PAGE_SIZE
): Page<T> {
  const all = Array.isArray(items) ? items : [];
  const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
  const limit = Math.max(1, options.limit ?? defaultLimit);
  const slice = all.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    items: slice,
    total: all.length,
    ...(next < all.length ? { nextCursor: String(next) } : {})
  };
}
