import { shellQuote } from './sandbox-session-commands';

const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function curlMethodArg(method: string): string | null {
  const upper = String(method ?? '').toUpperCase();
  if (!PROXY_METHODS.has(upper)) return null;
  return `-X ${shellQuote(upper)}`;
}
