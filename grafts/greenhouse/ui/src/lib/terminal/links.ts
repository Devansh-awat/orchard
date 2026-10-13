const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/g;
const TRAILING_RE = /[.,;:!?]+$/;

export function urlAt(text: string, offset: number): string | null {
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_RE, '');
    const start = match.index ?? 0;
    if (offset >= start && offset <= start + url.length) return url;
  }
  return null;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

export function linkUnderPointer(event: MouseEvent): string | null {
  if (!(event.target instanceof Element)) return null;
  if (event.target.closest('.term-link')) return null;
  const row = event.target.closest('.term-row');
  if (!row) return null;
  const caret = caretAt(event.clientX, event.clientY);
  if (!caret || !row.contains(caret.node)) return null;
  const before = document.createRange();
  before.setStart(row, 0);
  before.setEnd(caret.node, caret.offset);
  return urlAt(row.textContent ?? '', before.toString().length);
}

export function attachLinkOpener(host: HTMLElement): () => void {
  const listener = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    const url = linkUnderPointer(event);
    if (!url) return;
    event.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  host.addEventListener('click', listener);
  return () => host.removeEventListener('click', listener);
}
