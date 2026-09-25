import { createHmac, timingSafeEqual } from 'crypto';
import { branchFromRef, type PushEvent, type WebhookHeaders } from './git-provider';

const NULL_SHA = /^0+$/;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function firstLine(v: unknown): string {
  return (str(v) ?? 'No commit message').split('\n')[0];
}

function filesFromCommits(commits: unknown): string[] | null {
  if (!Array.isArray(commits)) return null;
  const out = new Set<string>();
  for (const c of commits) {
    if (!c || typeof c !== 'object') continue;
    for (const key of ['added', 'modified', 'removed'] as const) {
      const list = (c as Record<string, unknown>)[key];
      if (!Array.isArray(list)) return null;
      for (const f of list) if (typeof f === 'string') out.add(f);
    }
  }
  return [...out];
}

function sha(v: unknown): string | null {
  const s = str(v);
  return s && !NULL_SHA.test(s) ? s : null;
}

export function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GitHub, Gitea, Forgejo and Gogs share one push shape. */
export function parseGithubStylePush(body: unknown): PushEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const branch = branchFromRef(b.ref);
  const fullName = str(b.repository?.full_name);
  const url = str(b.repository?.html_url) ?? str(b.repository?.clone_url)?.replace(/\.git$/, '');
  if (!branch || !fullName || !url) return null;
  const head = b.head_commit ?? null;
  return {
    repoFullName: fullName,
    repoUrl: url,
    externalRepoId: b.repository?.id != null ? String(b.repository.id) : null,
    branch,
    commitSha: sha(b.after) ?? sha(head?.id),
    beforeSha: sha(b.before),
    message: firstLine(head?.message),
    authorName: str(head?.author?.name) ?? str(b.pusher?.full_name) ?? str(b.pusher?.name),
    authorUsername:
      str(head?.author?.username) ?? str(b.pusher?.username) ?? str(b.pusher?.login) ?? null,
    changedFiles: filesFromCommits(b.commits),
    deleted: Boolean(b.deleted) || str(b.after) === null || NULL_SHA.test(String(b.after))
  };
}

export function parseGitlabPush(body: unknown): PushEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  if (b.object_kind && b.object_kind !== 'push') return null;
  const branch = branchFromRef(b.ref);
  const fullName = str(b.project?.path_with_namespace);
  const url = str(b.project?.web_url) ?? str(b.project?.http_url)?.replace(/\.git$/, '');
  if (!branch || !fullName || !url) return null;
  const commits: any[] = Array.isArray(b.commits) ? b.commits : [];
  const head = commits.find((c) => c?.id === b.after) ?? commits[commits.length - 1] ?? null;
  return {
    repoFullName: fullName,
    repoUrl: url,
    externalRepoId: b.project?.id != null ? String(b.project.id) : null,
    branch,
    commitSha: sha(b.after) ?? sha(b.checkout_sha),
    beforeSha: sha(b.before),
    message: firstLine(head?.message),
    authorName: str(head?.author?.name) ?? str(b.user_name),
    authorUsername: str(b.user_username) ?? null,
    changedFiles: filesFromCommits(commits),
    deleted: NULL_SHA.test(String(b.after ?? ''))
  };
}

export function parseBitbucketPush(body: unknown): PushEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const change = Array.isArray(b.push?.changes) ? b.push.changes[0] : null;
  const fullName = str(b.repository?.full_name);
  const url = str(b.repository?.links?.html?.href);
  if (!change || !fullName || !url) return null;
  const target = change.new ?? null;
  const branch = target?.type === 'branch' ? str(target.name) : null;
  if (!branch && !change.closed) return null;
  const authorRaw = str(target?.target?.author?.raw);
  return {
    repoFullName: fullName,
    repoUrl: url,
    externalRepoId: str(b.repository?.uuid),
    branch: branch ?? str(change.old?.name) ?? '',
    commitSha: sha(target?.target?.hash),
    beforeSha: sha(change.old?.target?.hash),
    message: firstLine(target?.target?.message),
    authorName: authorRaw ? authorRaw.replace(/\s*<[^>]*>\s*$/, '') : null,
    authorUsername: str(target?.target?.author?.user?.nickname) ?? str(b.actor?.nickname),
    changedFiles: null,
    deleted: Boolean(change.closed) || !target
  };
}

export function verifyHmacHeader(
  headers: WebhookHeaders,
  header: string,
  rawBody: string,
  secret: string,
  prefix = ''
): boolean {
  const provided = headers[header.toLowerCase()];
  if (!provided) return false;
  return safeEqual(provided, `${prefix}${hmacHex(secret, rawBody)}`);
}
