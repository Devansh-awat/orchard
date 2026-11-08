export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  evidence: string;
  fix: string;
  docs: string;
}

export interface DoctorSummary {
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
}

export interface Fact<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export const DOCTOR_DOCS_BASE = (process.env.ORCHARD_DOCS_URL || 'https://docs.orchard.my').replace(
  /\/$/,
  ''
);

export function docsLink(id: string): string {
  return `${DOCTOR_DOCS_BASE}/operate/doctor/#${id}`;
}

export function check(
  id: string,
  title: string,
  status: CheckStatus,
  evidence: string,
  fix = ''
): DoctorCheck {
  return { id, title, status, evidence, fix, docs: docsLink(id) };
}

export function summarize(checks: DoctorCheck[]): DoctorSummary {
  const out: DoctorSummary = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const c of checks) out[c.status] += 1;
  return out;
}

export function errorMessage(error: unknown): string {
  const e = error as any;
  const status = e?.response?.statusCode ?? e?.statusCode ?? e?.code;
  const body = e?.response?.body?.message ?? e?.body?.message;
  const message = String(body ?? e?.message ?? error).slice(0, 300);
  return status ? `${status}: ${message}` : message;
}

export function isNotFound(error: unknown): boolean {
  const e = error as any;
  return (e?.response?.statusCode ?? e?.statusCode ?? e?.code) === 404;
}

export async function fact<T>(read: () => Promise<T>): Promise<Fact<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
