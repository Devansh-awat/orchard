/**
 * Transcodes BuildKit's `--progress=rawjson` stream into the `#id …` text
 * format the rest of the system already speaks.
 *
 * `--progress=plain` is a *display* format: BuildKit's textMux picks one vertex
 * at a time, prints its section, and holds every other vertex's updates until
 * it switches. So a step's `DONE` line can land long after the steps that
 * depend on it finished, and the UI ends up drawing spinners on work that
 * completed minutes ago. rawjson has no such buffering: each SolveStatus is
 * written the moment it arrives, carrying real `started`/`completed` stamps,
 * so folding it back into text here yields the same shape with causal order.
 *
 * Non-JSON lines pass through untouched, which keeps the plain-output builders
 * (super builds) working through the same path.
 */

/** One `client.Vertex` from BuildKit's status stream. */
interface RawVertex {
  digest?: string;
  name?: string;
  started?: string | null;
  completed?: string | null;
  cached?: boolean;
  error?: string;
}

/** One `client.VertexStatus`: a sub-progress line such as a layer transfer. */
interface RawStatus {
  id?: string;
  vertex?: string;
  name?: string;
  total?: number;
  current?: number;
  timestamp?: string;
  completed?: string | null;
}

/** One `client.VertexLog`: a chunk of a step's stdout/stderr, base64 encoded. */
interface RawLog {
  vertex?: string;
  data?: string;
  timestamp?: string;
}

interface RawSolveStatus {
  vertexes?: RawVertex[];
  statuses?: RawStatus[];
  logs?: RawLog[];
}

interface VertexState {
  id: string;
  startedMs: number | null;
  headerEmitted: boolean;
  finished: boolean;
  partialLine: string;
  lastStatusText: Map<string, string>;
  lastStatusAt: Map<string, number>;
}

/**
 * Step ids are derived from the vertex digest rather than a counter so they
 * survive a server restart mid-build: the offset bookkeeping resumes the same
 * job with a fresh transcoder, and a counter would renumber every step from 1
 * and merge unrelated rows in the UI.
 */
function vertexId(digest: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < digest.length; i++) {
    h ^= digest.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function parseTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** Vertex names and solver errors can span lines; the text format cannot. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0B';
  if (n < 1024) return `${Math.round(n)}B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(2)}${units[unit]}`;
}

export interface RawjsonTranscoder {
  /** Fold a chunk of the raw stream into text. Returns '' when nothing changed. */
  feed(chunk: string): string;
  /**
   * Close out the stream. Steps still open at this point were genuinely
   * interrupted: a build that ran to completion closes every vertex, since
   * the exporter is the sink of the graph.
   */
  flush(): string;
}

export function createRawjsonTranscoder(): RawjsonTranscoder {
  const vertices = new Map<string, VertexState>();
  let pending = '';

  function stateFor(digest: string): VertexState {
    let state = vertices.get(digest);
    if (!state) {
      state = {
        id: vertexId(digest),
        startedMs: null,
        headerEmitted: false,
        finished: false,
        partialLine: '',
        lastStatusText: new Map(),
        lastStatusAt: new Map()
      };
      vertices.set(digest, state);
    }
    return state;
  }

  function drainPartial(state: VertexState, out: string[]) {
    if (!state.partialLine) return;
    out.push(`#${state.id} ${state.partialLine}`);
    state.partialLine = '';
  }

  function emitHeaders(status: RawSolveStatus, out: string[]) {
    for (const vertex of status.vertexes ?? []) {
      if (!vertex.digest) continue;
      const state = stateFor(vertex.digest);
      // A vertex is announced as soon as the solver knows about it, long
      // before it runs. Only `started` means the work actually began, and
      // treating the announcement as a start is what painted queued steps as
      // running.
      if (!vertex.started) continue;
      // Take the latest start: a re-solved vertex gets a fresh one, and timing
      // from the stale stamp would report a duration that never happened.
      if (!state.finished) state.startedMs = parseTs(vertex.started);
      if (state.headerEmitted) continue;
      state.headerEmitted = true;
      out.push(`#${state.id} ${oneLine(vertex.name ?? '')}`.trimEnd());
    }
  }

  function emitLogs(status: RawSolveStatus, out: string[]) {
    for (const log of status.logs ?? []) {
      if (!log.vertex || !log.data) continue;
      const state = stateFor(log.vertex);
      let text: string;
      try {
        text = Buffer.from(log.data, 'base64').toString('utf8');
      } catch {
        continue;
      }
      const at = parseTs(log.timestamp);
      const elapsed =
        at !== null && state.startedMs !== null
          ? `${((at - state.startedMs) / 1000).toFixed(3)} `
          : '';
      const lines = (state.partialLine + text).split('\n');
      state.partialLine = lines.pop() ?? '';
      for (const line of lines) {
        out.push(`#${state.id} ${elapsed}${line.replace(/\r$/, '')}`);
      }
    }
  }

  function emitStatuses(status: RawSolveStatus, out: string[]) {
    for (const entry of status.statuses ?? []) {
      if (!entry.vertex) continue;
      const state = stateFor(entry.vertex);
      const current = entry.current ?? 0;
      const total = entry.total ?? 0;
      if (current <= 0 && total <= 0) continue;
      // BuildKit's own text output labels these with the status id, which is
      // the specific thing moving ("transferring dockerfile:", a layer digest)
      // rather than the generic verb in `name`.
      const label = oneLine(entry.id || entry.name || 'progress');
      const key = `${entry.id ?? ''}:${entry.name ?? ''}`;
      const text = `#${state.id} ${label} ${formatBytes(current)}${entry.completed ? ' done' : ''}`;
      if (state.lastStatusText.get(key) === text) continue;
      // A large layer ticks thousands of times. Only the final reading has to
      // land; the rest are a liveness signal, and one a second is plenty.
      const at = parseTs(entry.timestamp);
      const last = state.lastStatusAt.get(key);
      if (!entry.completed && at !== null && last !== undefined && at - last < 1000) continue;
      state.lastStatusText.set(key, text);
      if (at !== null) state.lastStatusAt.set(key, at);
      out.push(text);
    }
  }

  function emitCompletions(status: RawSolveStatus, out: string[]) {
    for (const vertex of status.vertexes ?? []) {
      if (!vertex.digest || !vertex.completed) continue;
      const state = stateFor(vertex.digest);
      // A vertex can flip back to started after completing while BuildKit
      // re-solves it. Like BuildKit's own text output, the first completion is
      // the one reported, so the step does not close and reopen in the UI.
      if (state.finished) continue;
      // A cached vertex is reported complete without ever being announced as
      // started, so the header still has to go out first.
      if (!state.headerEmitted) {
        state.headerEmitted = true;
        state.startedMs = parseTs(vertex.started);
        out.push(`#${state.id} ${oneLine(vertex.name ?? '')}`.trimEnd());
      }
      drainPartial(state, out);
      state.finished = true;
      if (vertex.error) {
        out.push(`#${state.id} ERROR: ${oneLine(vertex.error)}`);
      } else if (vertex.cached) {
        out.push(`#${state.id} CACHED`);
      } else {
        const startedMs = state.startedMs ?? parseTs(vertex.started);
        const completedMs = parseTs(vertex.completed);
        const seconds =
          startedMs !== null && completedMs !== null ? (completedMs - startedMs) / 1000 : 0;
        out.push(`#${state.id} DONE ${Math.max(seconds, 0).toFixed(1)}s`);
      }
    }
  }

  function feedLine(line: string, out: string[]) {
    if (!line.startsWith('{')) {
      out.push(line);
      return;
    }
    let parsed: RawSolveStatus;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      out.push(line);
      return;
    }
    if (!parsed.vertexes && !parsed.statuses && !parsed.logs) {
      out.push(line);
      return;
    }
    emitHeaders(parsed, out);
    emitLogs(parsed, out);
    emitStatuses(parsed, out);
    emitCompletions(parsed, out);
  }

  return {
    feed(chunk: string): string {
      if (!chunk) return '';
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      const out: string[] = [];
      for (const line of lines) {
        if (line.trim()) feedLine(line, out);
      }
      return out.length ? `${out.join('\n')}\n` : '';
    },

    flush(): string {
      const out: string[] = [];
      if (pending.trim()) feedLine(pending, out);
      pending = '';
      for (const state of vertices.values()) {
        drainPartial(state, out);
        if (state.finished || !state.headerEmitted) continue;
        state.finished = true;
        out.push(`#${state.id} CANCELED`);
      }
      return out.length ? `${out.join('\n')}\n` : '';
    }
  };
}

/** One-shot transcode of a complete raw stream, for after-the-fact analysis. */
export function transcodeRawjson(raw: string | null | undefined): string {
  if (!raw) return '';
  const transcoder = createRawjsonTranscoder();
  return transcoder.feed(raw) + transcoder.flush();
}
