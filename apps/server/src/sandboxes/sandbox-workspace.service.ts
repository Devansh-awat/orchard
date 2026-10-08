import * as http from 'http';
import * as https from 'https';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SandboxProbesService } from './runners/sandbox-probes.service';
import {
  HttpTarget,
  SandboxNotRunningError,
  SandboxRef,
  SandboxRowLike,
  refOf
} from './runners/sandbox-runner';

const OPENCODE_PORT = 4096;
const PROXY_TIMEOUT_MS = 120000;
const MAX_FILE_BYTES = 512000;

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/ @-]*$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_DIFF_BYTES = 200000;

export type WorkspaceSandbox = SandboxRowLike & { status: string; repoUrl: string | null };

export function sandboxWorkdir(repoUrl: string | null): string {
  if (!repoUrl) return '/persist/home';
  const base =
    repoUrl
      .replace(/\.git$/, '')
      .split('/')
      .pop() || '';
  return base ? `/persist/home/${base}` : '/persist/home';
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface SandboxRepo {
  name: string;
  branch: string | null;
  dirtyFiles: number;
}

export interface SandboxChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface SandboxChanges {
  isRepo: boolean;
  branch: string | null;
  files: SandboxChangedFile[];
}

@Injectable()
export class SandboxWorkspaceService {
  private readonly logger = new Logger(SandboxWorkspaceService.name);

  constructor(
    private readonly registry: SandboxRunnerRegistry,
    private readonly probes: SandboxProbesService
  ) {}

  private requireRunning(sandbox: { status: string }): void {
    if (sandbox.status !== 'running') throw new SandboxNotRunningError();
  }

  async proxyOpencode(sandbox: WorkspaceSandbox, req: Request, res: Response): Promise<void> {
    if (sandbox.status !== 'running') {
      res.status(400).json({ message: 'Sandbox is not running' });
      return;
    }
    const marker = '/opencode/';
    const tail = req.originalUrl.slice(req.originalUrl.indexOf(marker) + marker.length);
    const queryAt = tail.indexOf('?');
    const suffix = queryAt === -1 ? tail : tail.slice(0, queryAt);
    const query = queryAt === -1 ? '' : tail.slice(queryAt);
    const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body !== undefined;
    const payload = hasBody ? JSON.stringify(req.body) : null;
    const ref = refOf(sandbox);
    let target: HttpTarget;
    try {
      target = await this.registry.for(sandbox).httpTarget(ref, OPENCODE_PORT);
    } catch (e: any) {
      res.status(502).json({ message: e?.message || 'opencode is not reachable in this sandbox' });
      return;
    }
    if (target.kind === 'exec') {
      await this.proxyOpencodeViaExec(sandbox, req, res, suffix, query, payload);
      return;
    }
    const base = new URL(target.baseUrl);
    const client = base.protocol === 'https:' ? https : http;
    const basePath = base.pathname.replace(/\/$/, '');
    await new Promise<void>((resolve) => {
      const proxyReq = client.request(
        {
          protocol: base.protocol,
          host: base.hostname,
          port: base.port || (base.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: `${basePath}/${suffix}${query}`,
          headers: {
            ...target.headers,
            accept: req.headers.accept || 'application/json',
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload)
                }
              : {})
          },
          timeout: PROXY_TIMEOUT_MS
        },
        (proxyRes) => {
          res.status(proxyRes.statusCode || 502);
          for (const header of ['content-type', 'cache-control']) {
            const value = proxyRes.headers[header];
            if (value) res.setHeader(header, value);
          }
          res.flushHeaders?.();
          proxyRes.pipe(res);
          proxyRes.on('end', resolve);
          proxyRes.on('error', () => {
            res.end();
            resolve();
          });
        }
      );
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('opencode proxy timeout')));
      proxyReq.on('error', (e) => {
        this.logger.warn(`opencode proxy failed for ${sandbox.id}: ${e.message}`);
        if (!res.headersSent)
          res.status(502).json({ message: 'opencode is not reachable in this sandbox' });
        else res.end();
        resolve();
      });
      res.on('close', () => proxyReq.destroy());
      if (payload) proxyReq.write(payload);
      proxyReq.end();
    });
  }

  resolveWorkdir(sandbox: { repoUrl: string | null }, repo: string | undefined): string {
    if (repo) {
      if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.includes('..')) {
        throw new BadRequestException('Invalid repo name');
      }
      return `/persist/home/${repo}`;
    }
    return sandboxWorkdir(sandbox.repoUrl);
  }

  private async run(
    sandbox: WorkspaceSandbox,
    script: string,
    repo?: string
  ): Promise<{ stdout: string; ok: boolean }> {
    this.requireRunning(sandbox);
    const dir = this.resolveWorkdir(sandbox, repo);
    return this.registry
      .for(sandbox)
      .exec(refOf(sandbox), [
        'su',
        '-l',
        'dev',
        '-c',
        `cd ${shellQuote(dir)} 2>/dev/null || exit 3; ${script}`
      ]);
  }

  private devExec(sandbox: WorkspaceSandbox, script: string) {
    return this.registry.for(sandbox).exec(refOf(sandbox), ['su', '-l', 'dev', '-c', script]);
  }

  private q(s: string): string {
    return shellQuote(s);
  }

  private validateFile(file: string): string {
    if (typeof file !== 'string' || !FILE_RE.test(file) || file.includes('..')) {
      throw new BadRequestException('Invalid file path');
    }
    return file;
  }

  private validateBranch(branch: string): string {
    if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.length > 200) {
      throw new BadRequestException('Invalid branch name');
    }
    return branch;
  }

  async gitCommit(
    sandbox: WorkspaceSandbox,
    repo: string,
    message: string,
    files: string[] | undefined,
    author: { name: string; email: string },
    opts: { amend?: boolean; signoff?: boolean; trackedOnly?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    if (!opts.amend && (!message?.trim() || message.length > 2000)) {
      throw new BadRequestException('A commit message is required');
    }
    const stage = files?.length
      ? files.map((f) => `git add -- ${this.q(this.validateFile(f))}`).join('\n')
      : opts.trackedOnly
        ? 'git add -u'
        : 'git add -A';
    const flags = [
      opts.amend ? '--amend' : '',
      opts.signoff ? '--signoff' : '',
      message?.trim() ? `-m ${this.q(message)}` : '--no-edit'
    ]
      .filter(Boolean)
      .join(' ');
    const script = `${stage}\ngit -c user.name=${this.q(author.name)} -c user.email=${this.q(author.email)} commit ${flags} 2>&1`;
    const result = await this.run(sandbox, script, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitUncommit(
    sandbox: WorkspaceSandbox,
    repo: string
  ): Promise<{ ok: boolean; output: string }> {
    const result = await this.run(
      sandbox,
      'git reset --soft HEAD~1 2>&1 && git log -1 --oneline 2>&1',
      repo
    );
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitPush(
    sandbox: WorkspaceSandbox,
    repo: string,
    opts: { force?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    const flags = opts.force ? ' --force-with-lease' : '';
    const result = await this.run(sandbox, `git push${flags} origin HEAD 2>&1`, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitFetch(
    sandbox: WorkspaceSandbox,
    repo: string
  ): Promise<{ ok: boolean; output: string }> {
    const result = await this.run(sandbox, 'git fetch --all --prune 2>&1', repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) || 'up to date' };
  }

  async gitPull(
    sandbox: WorkspaceSandbox,
    repo: string,
    opts: { rebase?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    const flags = opts.rebase ? ' --rebase' : '';
    const result = await this.run(sandbox, `git pull${flags} 2>&1`, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitBranches(
    sandbox: WorkspaceSandbox,
    repo: string
  ): Promise<{
    current: string | null;
    local: Array<{ name: string; upstream: string | null; ahead: number; behind: number }>;
    remote: string[];
  }> {
    const script = [
      'git rev-parse --abbrev-ref HEAD',
      "echo '@@local@@'",
      "git for-each-ref --format='%(refname:short)|%(upstream:short)|%(upstream:track)' refs/heads",
      "echo '@@remote@@'",
      "git for-each-ref --format='%(refname:short)' refs/remotes"
    ].join('\n');
    const result = await this.run(sandbox, script, repo);
    const [head = '', rest = ''] = result.stdout.split('@@local@@');
    const [localPart = '', remotePart = ''] = rest.split('@@remote@@');
    const local = localPart
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, upstream, track] = line.split('|');
        const ahead = Number(track?.match(/ahead (\d+)/)?.[1] || 0);
        const behind = Number(track?.match(/behind (\d+)/)?.[1] || 0);
        return { name, upstream: upstream || null, ahead, behind };
      });
    const remote = remotePart
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith('/HEAD'));
    return { current: head.trim() || null, local, remote };
  }

  async gitCheckout(
    sandbox: WorkspaceSandbox,
    repo: string,
    branch: string,
    opts: { create?: boolean; from?: string } = {}
  ): Promise<{ ok: boolean; output: string }> {
    this.validateBranch(branch);
    const from = opts.from ? ` ${this.q(this.validateBranch(opts.from))}` : '';
    const script = opts.create
      ? `git checkout -b ${this.q(branch)}${from} 2>&1`
      : `git checkout ${this.q(branch)} 2>&1`;
    const result = await this.run(sandbox, script, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitDeleteBranch(
    sandbox: WorkspaceSandbox,
    repo: string,
    branch: string,
    opts: { remote?: boolean; force?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    this.validateBranch(branch);
    const script = opts.remote
      ? `git push origin --delete ${this.q(branch)} 2>&1`
      : `git branch ${opts.force ? '-D' : '-d'} ${this.q(branch)} 2>&1`;
    const result = await this.run(sandbox, script, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async createPullRequest(
    sandbox: WorkspaceSandbox,
    repo: string,
    githubToken: string | null,
    body: { title?: string; body?: string; base?: string }
  ): Promise<{ url: string }> {
    if (!body.title?.trim()) throw new BadRequestException('A PR title is required');
    if (!githubToken) {
      throw new BadRequestException('No GitHub account is linked to your user');
    }
    const info = await this.run(
      sandbox,
      'git remote get-url origin; git rev-parse --abbrev-ref HEAD',
      repo
    );
    const [remoteUrl, branch] = info.stdout
      .trim()
      .split('\n')
      .map((l) => l.trim());
    const match = remoteUrl?.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match || !branch) {
      throw new BadRequestException('Could not determine the GitHub repository or branch');
    }
    const [, owner, name] = match;
    const headers = {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'orchard-greenhouse'
    };
    let base = body.base;
    if (!base) {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
      if (repoRes.ok) base = ((await repoRes.json()) as any).default_branch;
    }
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: body.title,
        head: branch,
        base: base || 'main',
        ...(body.body ? { body: body.body } : {})
      })
    });
    const pr = (await prRes.json()) as any;
    if (!prRes.ok) {
      throw new BadRequestException(
        pr?.errors?.[0]?.message || pr?.message || 'GitHub rejected the pull request'
      );
    }
    return { url: pr.html_url };
  }

  async readFile(
    sandbox: WorkspaceSandbox,
    repo: string | undefined,
    file: string
  ): Promise<{ content: string; truncated: boolean }> {
    this.validateFile(file);
    this.requireRunning(sandbox);
    const dir = this.resolveWorkdir(sandbox, repo);
    const result = await this.registry
      .for(sandbox)
      .readFile(refOf(sandbox), `${dir}/${file}`, { maxBytes: MAX_FILE_BYTES, asUser: 'dev' })
      .catch((e) => {
        if (e instanceof SandboxNotRunningError) throw e;
        return null;
      });
    if (!result) throw new BadRequestException('Could not read that file');
    return { content: result.content.toString('utf8'), truncated: result.truncated };
  }

  async writeFile(
    sandbox: WorkspaceSandbox,
    repo: string | undefined,
    file: string,
    content: string
  ): Promise<{ ok: boolean }> {
    this.validateFile(file);
    if (typeof content !== 'string' || content.length > MAX_FILE_BYTES) {
      throw new BadRequestException('File content must be a string up to 500KB');
    }
    this.requireRunning(sandbox);
    const dir = this.resolveWorkdir(sandbox, repo);
    try {
      await this.registry
        .for(sandbox)
        .writeFiles(
          refOf(sandbox),
          [{ path: `${dir}/${file}`, content: Buffer.from(content, 'utf8') }],
          { asUser: 'dev' }
        );
    } catch (e: any) {
      if (e instanceof SandboxNotRunningError) throw e;
      this.logger.warn(`file write failed for ${sandbox.id}: ${e?.message}`);
      throw new BadRequestException('Could not write that file');
    }
    return { ok: true };
  }

  async bootStatus(
    sandbox: WorkspaceSandbox
  ): Promise<{ phase: string; ready: boolean; label: string }> {
    const labels: Record<string, string> = {
      starting: 'Starting the virtual machine',
      packages: 'Installing system packages',
      runtime: 'Installing Node.js',
      agents: 'Installing coding agents',
      storage: 'Preparing persistent storage',
      account: 'Creating your user account',
      services: 'Starting SSH and the agent server',
      ready: 'Ready'
    };
    if (sandbox.status !== 'running') {
      return { phase: sandbox.status, ready: false, label: 'Sandbox is not running' };
    }
    let phase = 'starting';
    try {
      phase = (await this.probes.bootPhase(sandbox)) || 'starting';
    } catch {
      return { phase: 'starting', ready: false, label: labels.starting };
    }
    return { phase, ready: phase === 'ready', label: labels[phase] || 'Setting up' };
  }

  async listRepos(sandbox: WorkspaceSandbox): Promise<{ repos: SandboxRepo[] }> {
    this.requireRunning(sandbox);
    const script = [
      'for d in /persist/home/*/.git; do',
      '  [ -e "$d" ] || continue',
      '  r="${d%/.git}"',
      '  b=$(git -C "$r" rev-parse --abbrev-ref HEAD 2>/dev/null)',
      '  n=$(git -C "$r" status --porcelain 2>/dev/null | wc -l)',
      '  echo "${r##*/}|$b|$n"',
      'done'
    ].join('\n');
    const result = await this.devExec(sandbox, script);
    const repos: SandboxRepo[] = [];
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length !== 3 || !parts[0]) continue;
      repos.push({
        name: parts[0],
        branch: parts[1] || null,
        dirtyFiles: Number(parts[2]) || 0
      });
    }
    return { repos };
  }

  async addRepo(sandbox: WorkspaceSandbox, repoUrl: string): Promise<{ name: string }> {
    this.requireRunning(sandbox);
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      throw new BadRequestException('repoUrl must be a valid URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('repoUrl must be an https URL');
    }
    const name =
      parsed.pathname
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean)
        .pop() || '';
    if (!REPO_RE.test(name)) {
      throw new BadRequestException('Could not derive a repo directory name from that URL');
    }
    const target = `/persist/home/${name}`;
    const script = [
      `[ -e ${shellQuote(target)} ] && exit 4`,
      `nohup git clone ${shellQuote(parsed.href)} ${shellQuote(target)} >> /persist/home/.clone.log 2>&1 &`,
      'exit 0'
    ].join('\n');
    const result = await this.devExec(sandbox, script);
    if (!result.ok) {
      throw new BadRequestException(`A directory named "${name}" already exists in the sandbox`);
    }
    return { name };
  }

  private async proxyOpencodeViaExec(
    sandbox: WorkspaceSandbox,
    req: Request,
    res: Response,
    suffix: string,
    query: string,
    payload: string | null
  ): Promise<void> {
    const isSse = String(req.headers.accept || '').includes('text/event-stream');
    let curl = `curl -si -N -X ${req.method} ${shellQuote(`http://127.0.0.1:${OPENCODE_PORT}/${suffix}${query}`)} -H ${shellQuote(`accept: ${req.headers.accept || 'application/json'}`)}`;
    if (payload) curl += ` -H 'content-type: application/json' --data-binary @-`;
    if (!isSse) curl += ' -m 110';
    const ref: SandboxRef = refOf(sandbox);
    let stream;
    try {
      stream = await this.registry.for(sandbox).execStream(ref, ['su', '-l', 'dev', '-c', curl], {
        stdin: payload ? Buffer.from(payload, 'utf8') : undefined
      });
    } catch (e: any) {
      this.logger.warn(`opencode exec proxy failed for ${sandbox.id}: ${e?.message}`);
      res.status(502).json({ message: e?.message || 'opencode is not reachable in this sandbox' });
      return;
    }
    let headerBuffer = '';
    let headersDone = false;
    stream.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        if (!res.writableEnded) res.write(chunk);
        return;
      }
      headerBuffer += chunk.toString('latin1');
      const sep = headerBuffer.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const head = headerBuffer.slice(0, sep);
      const rest = Buffer.from(headerBuffer.slice(sep + 4), 'latin1');
      const statusMatch = head.match(/^HTTP\/[\d.]+ (\d{3})/);
      const typeMatch = head.match(/^content-type:\s*(.+)$/im);
      res.status(statusMatch ? Number(statusMatch[1]) : 200);
      res.setHeader('content-type', typeMatch ? typeMatch[1].trim() : 'application/json');
      if (isSse) {
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('x-accel-buffering', 'no');
      }
      res.flushHeaders?.();
      headersDone = true;
      if (rest.length && !res.writableEnded) res.write(rest);
    });
    res.on('close', () => stream.kill());
    await stream.done;
    if (!headersDone && !res.headersSent) {
      res.status(502).json({ message: 'opencode is not reachable in this sandbox' });
      return;
    }
    if (!res.writableEnded) res.end();
  }

  async changes(sandbox: WorkspaceSandbox, repo?: string): Promise<SandboxChanges> {
    const script = [
      'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3',
      'echo "@@branch@@$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
      'git status --porcelain',
      'echo "@@numstat@@"',
      'git diff --numstat HEAD 2>/dev/null'
    ].join('; ');
    const result = await this.run(sandbox, script, repo);
    if (!result.ok && !result.stdout.includes('@@branch@@')) {
      return { isRepo: false, branch: null, files: [] };
    }
    const [statusPart, numstatPart = ''] = result.stdout.split('@@numstat@@');
    const counts = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const line of numstatPart.split('\n')) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      counts.set(m[3], {
        additions: m[1] === '-' ? null : Number(m[1]),
        deletions: m[2] === '-' ? null : Number(m[2])
      });
    }
    let branch: string | null = null;
    const files: SandboxChangedFile[] = [];
    for (const line of statusPart.split('\n')) {
      const branchMatch = line.match(/@@branch@@(.*)$/);
      if (branchMatch) {
        branch = branchMatch[1].trim() || null;
        continue;
      }
      if (line.length < 4) continue;
      const status = line.slice(0, 2).trim();
      const path = line.slice(3).trim().replace(/^"|"$/g, '');
      if (!path) continue;
      const c = counts.get(path);
      files.push({
        path,
        status,
        additions: c?.additions ?? null,
        deletions: c?.deletions ?? null
      });
    }
    return { isRepo: true, branch, files };
  }

  async diff(
    sandbox: WorkspaceSandbox,
    file: string | undefined,
    repo?: string
  ): Promise<{ diff: string; truncated: boolean }> {
    let script: string;
    if (file) {
      if (typeof file !== 'string' || !FILE_RE.test(file) || file.includes('..')) {
        throw new BadRequestException('Invalid file path');
      }
      script = [
        `git diff HEAD -- '${file}'`,
        `if git status --porcelain -- '${file}' | grep -q '^??'; then git diff --no-index -- /dev/null '${file}' || true; fi`
      ].join('; ');
    } else {
      script = 'git diff HEAD';
    }
    const result = await this.run(sandbox, `{ ${script}; } | head -c ${MAX_DIFF_BYTES + 1}`, repo);
    const truncated = result.stdout.length > MAX_DIFF_BYTES;
    return {
      diff: truncated ? result.stdout.slice(0, MAX_DIFF_BYTES) : result.stdout,
      truncated
    };
  }
}
