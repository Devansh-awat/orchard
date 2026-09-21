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
