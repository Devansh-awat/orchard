const SHARE_TOKEN_PATH_RE = /(\/share\/[a-z][a-z0-9-]*\/)(?!sessions(?:[/?#]|$))[^/?#]+/g;
const DEPLOY_WEBHOOK_PATH_RE = /(\/webhooks\/deploy\/)[^/?#]+/g;

export const REDACTED_SEGMENT = '[redacted]';

export function redactSensitivePath(url: string): string {
  if (typeof url !== 'string') return url;
  let out = url;
  if (out.includes('/share/')) out = out.replace(SHARE_TOKEN_PATH_RE, `$1${REDACTED_SEGMENT}`);
  if (out.includes('/webhooks/deploy/')) {
    out = out.replace(DEPLOY_WEBHOOK_PATH_RE, `$1${REDACTED_SEGMENT}`);
  }
  return out;
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
