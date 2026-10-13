import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { browser } from '../../../host/environment';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

function sanitizer() {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A' || !node.getAttribute('href')) return;
    const href = node.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  purifier = instance;
  return instance;
}

export function renderMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const html = marked.parse(trimmed, { async: false }) as string;
  if (!browser) return escapeHtml(trimmed);
  return sanitizer().sanitize(html, { ADD_ATTR: ['target'] });
}
