const SHARE_TOKEN_PATH_RE = /(\/share\/[a-z][a-z0-9-]*\/)(?!sessions(?:[/?#]|$))[^/?#]+/g;

export const REDACTED_SEGMENT = '[redacted]';

export function redactSensitivePath(url: string): string {
  if (typeof url !== 'string' || !url.includes('/share/')) return url;
  return url.replace(SHARE_TOKEN_PATH_RE, `$1${REDACTED_SEGMENT}`);
}

const SPAN_URL_TAGS = ['http.url', 'http.endpoint'] as const;

interface TaggableSpan {
  context(): unknown;
  setTag(key: string, value: unknown): unknown;
}

export function redactSpanUrls(span: TaggableSpan | undefined): void {
  if (!span) return;
  const context = span.context() as {
    getTag?: (key: string) => unknown;
    _tags?: Record<string, unknown>;
  } | null;
  for (const tag of SPAN_URL_TAGS) {
    const value = context?.getTag?.(tag) ?? context?._tags?.[tag];
    if (typeof value !== 'string') continue;
    const redacted = redactSensitivePath(value);
    if (redacted !== value) span.setTag(tag, redacted);
  }
}
