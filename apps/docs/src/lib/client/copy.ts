const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

function fetchText(url: string): Promise<string | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) as string);
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;
  const request = fetch(url)
    .then((response) => (response.ok ? response.text() : null))
    .then((text) => {
      if (text !== null) cache.set(url, text);
      return text;
    })
    .catch(() => null)
    .finally(() => pending.delete(url));
  pending.set(url, request);
  return request;
}

async function write(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return legacyWrite(text);
  }
  return legacyWrite(text);
}

function legacyWrite(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

function announce(message: string) {
  let region = document.getElementById('o-live');
  if (!region) {
    region = document.createElement('div');
    region.id = 'o-live';
    region.className = 'sr-only';
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  region.textContent = message;
}

function flash(button: HTMLElement, ok: boolean) {
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  const message = ok ? (button.dataset.copiedText ?? 'Copied') : 'Copy failed';
  const original = label?.dataset.original ?? label?.textContent ?? '';
  if (label) {
    label.dataset.original = original;
    label.textContent = message;
  }
  button.dataset.copied = String(ok);
  announce(message);
  window.setTimeout(() => {
    if (label) label.textContent = original;
    delete button.dataset.copied;
  }, 1600);
}

function primeFrom(target: EventTarget | null) {
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>('[data-copy-url]');
  if (button?.dataset.copyUrl) void fetchText(button.dataset.copyUrl);
}

document.addEventListener('pointerover', (event) => primeFrom(event.target));
document.addEventListener('focusin', (event) => primeFrom(event.target));
document.addEventListener('touchstart', (event) => primeFrom(event.target), { passive: true });

document.addEventListener('click', async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>('[data-copy],[data-copy-url]');
  if (!button) return;
  const text = button.dataset.copyUrl
    ? await fetchText(button.dataset.copyUrl)
    : (button.dataset.copy ?? null);
  flash(button, text !== null && (await write(text)));
});
