export function sheetScrollEdges(node: HTMLElement) {
  const body = node.closest<HTMLElement>('.ui-modal-body');
  const dialog = node.closest<HTMLElement>('.ui-modal');
  if (!body || !dialog) return;
  const sync = () => {
    dialog.toggleAttribute('data-scrolled', body.scrollTop > 0);
    dialog.toggleAttribute('data-more', body.scrollTop + body.clientHeight < body.scrollHeight - 1);
  };
  sync();
  body.addEventListener('scroll', sync, { passive: true });
  const observer = new ResizeObserver(sync);
  observer.observe(body);
  observer.observe(node);
  return () => {
    body.removeEventListener('scroll', sync);
    observer.disconnect();
    dialog.removeAttribute('data-scrolled');
    dialog.removeAttribute('data-more');
  };
}
