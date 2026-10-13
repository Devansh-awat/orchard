import type { PredictTarget } from '../utils/terminal-predict';
import type { TerminalHandle } from './create';

export interface DisposablePredictTarget extends PredictTarget {
  dispose(): void;
}

export const PREDICT_OVERLAY_CLASS = 'term-predict-overlay';
export const PREDICT_CURSOR_CLASS = 'term-predict-cursor';

function liveRow(host: HTMLElement, rows: number, row: number): HTMLElement | null {
  const grid = host.querySelector<HTMLElement>(':scope > .term-grid');
  if (!grid) return null;
  const live = grid.querySelectorAll<HTMLElement>(':scope > .term-row:not(.term-scrollback-row)');
  if (live.length !== rows) return null;
  return live[row] ?? null;
}

interface Placement {
  row: number;
  x: number;
  text: string;
  cursor: number;
}

export function wtermPredictTarget(handle: TerminalHandle): DisposablePredictTarget {
  const host = handle.wt.element;
  const core = handle.core;
  let overlay: HTMLDivElement | null = null;
  let placement: Placement | null = null;
  let frame: number | null = null;

  function hideOverlay(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    placement = null;
    overlay?.remove();
    overlay = null;
  }

  function pin(): void {
    const at = placement;
    if (!at) return;
    const rowEl = liveRow(host, handle.rows, at.row);
    const grid = rowEl?.parentElement;
    if (!rowEl || !grid) {
      hideOverlay();
      return;
    }
    const cell = parseFloat(getComputedStyle(host).getPropertyValue('--term-cell-width')) || 0;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = PREDICT_OVERLAY_CLASS;
      overlay.setAttribute('aria-hidden', 'true');
      overlay.append(document.createTextNode(''), document.createElement('span'));
      (overlay.lastChild as HTMLElement).className = PREDICT_CURSOR_CLASS;
    }
    if (overlay.parentElement !== host) host.appendChild(overlay);
    (overlay.firstChild as Text).data = at.text;
    (overlay.lastChild as HTMLElement).style.left = `${at.cursor * cell}px`;
    overlay.style.top = `${grid.offsetTop + rowEl.offsetTop}px`;
    overlay.style.left = `${grid.offsetLeft + at.x * cell}px`;
    overlay.style.width = `${Math.max(at.text.length, at.cursor + 1) * cell}px`;
  }

  function showOverlay(row: number, x: number, text: string, cursor: number): void {
    placement = { row, x, text, cursor };
    pin();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (!placement) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      pin();
    });
  }

  return {
    get cols() {
      return handle.cols;
    },
    cursor() {
      const c = core.getCursor();
      return { x: c.col, y: c.row };
    },
    cellAt(row, col) {
      const cell = core.getCell(row, col);
      if (cell.width === 0) return '\u0000';
      if (cell.chars) return cell.chars;
      return cell.char > 0 ? String.fromCodePoint(cell.char) : ' ';
    },
    isAlternate() {
      return core.usingAltScreen();
    },
    mouseTracking() {
      return core.mouseTracking() !== 0;
    },
    scrolledBack() {
      return handle.scrolledBack();
    },
    write(data, done) {
      handle.write(data, done);
    },
    showOverlay,
    hideOverlay,
    dispose: hideOverlay
  };
}
