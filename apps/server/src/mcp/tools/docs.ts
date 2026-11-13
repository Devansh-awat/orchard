import { McpServer } from '@modelcontextprotocol/server';
import { YAML_FORMAT_GUIDE } from './query';

export const DOCS_URL = (
  process.env.ORCHARD_DOCS_URL || 'https://docs.orchard.hackclub.com'
).replace(/\/$/, '');

export const TEMPLATE_GUIDE_URI = 'orchard://docs/template-yaml-guide';
export const LLMS_TXT_URI = 'orchard://docs/llms.txt';

const LLMS_TIMEOUT_MS = 5_000;

export async function fetchLlmsTxt(fetcher: typeof fetch = fetch): Promise<string> {
  const url = `${DOCS_URL}/llms.txt`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(LLMS_TIMEOUT_MS) });
    if (res.ok) return await res.text();
    return `Could not load ${url} (HTTP ${res.status}). Read it directly at ${url}.`;
  } catch (err) {
    return `Could not load ${url} (${err instanceof Error ? err.message : String(err)}). Read it directly at ${url}.`;
  }
}

export function registerDocResources(server: McpServer) {
  server.registerResource(
    'template-yaml-guide',
    TEMPLATE_GUIDE_URI,
    {
      title: 'Orchard template YAML guide',
      description:
        'The leaf/v1 template format: parameters, resource types, interpolation and a full example.',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: YAML_FORMAT_GUIDE.trim() }]
    })
  );

  server.registerResource(
    'llms-txt',
    LLMS_TXT_URI,
    {
      title: 'Orchard docs index (llms.txt)',
      description: `Index of the Orchard documentation for agents, from ${DOCS_URL}/llms.txt.`,
      mimeType: 'text/plain'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: await fetchLlmsTxt() }]
    })
  );
}
