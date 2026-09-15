import * as http from 'http';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { SandboxK8sService, sandboxWorkdir } from './sandbox-k8s.service';
import { SANDBOX_PHASE_FILE } from './sandbox-bootstrap';

const OPENCODE_PORT = 4096;
const PROXY_TIMEOUT_MS = 120000;

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/ @-]*$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_DIFF_BYTES = 200000;

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
    private readonly k8s: SandboxK8sService,
    private readonly kubernetes: KubernetesService
  ) {}

  async proxyOpencode(
    sandbox: { id: string; podName: string; status: string },
    req: Request,
    res: Response
  ): Promise<void> {
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
    if (process.env.SANDBOX_TUNNEL_MODE === 'portforward') {
      await this.proxyOpencodeViaExec(sandbox, req, res, suffix, query, payload);
      return;
    }
    const podIp = await this.k8s.resolvePodIp(sandbox.id, sandbox.podName);
    if (!podIp) {
      res.status(502).json({ message: 'Sandbox pod has no address' });
      return;
    }
    await new Promise<void>((resolve) => {
      const proxyReq = http.request(
        {
          host: podIp,
          port: OPENCODE_PORT,
          method: req.method,
          path: `/${suffix}${query}`,
          headers: {
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
    sandbox: { id: string; status: string; repoUrl: string | null },
    script: string,
    repo?: string
  ): Promise<{ stdout: string; ok: boolean }> {
    if (sandbox.status !== 'running') {
      throw new BadRequestException('Sandbox is not running');
    }
    const dir = this.resolveWorkdir(sandbox, repo);
    return this.k8s.execCapture(sandbox.id, [
      'su',
      '-l',
      'dev',
      '-c',
      `cd '${dir}' 2>/dev/null || exit 3; ${script}`
    ]);
  }

  private q(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
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
    sandbox: { id: string; status: string; repoUrl: string | null },
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
    sandbox: { id: string; status: string; repoUrl: string | null },
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
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo: string,
    opts: { force?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    const flags = opts.force ? ' --force-with-lease' : '';
    const result = await this.run(sandbox, `git push${flags} origin HEAD 2>&1`, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitFetch(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo: string
  ): Promise<{ ok: boolean; output: string }> {
    const result = await this.run(sandbox, 'git fetch --all --prune 2>&1', repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) || 'up to date' };
  }

  async gitPull(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo: string,
    opts: { rebase?: boolean } = {}
  ): Promise<{ ok: boolean; output: string }> {
    const flags = opts.rebase ? ' --rebase' : '';
    const result = await this.run(sandbox, `git pull${flags} 2>&1`, repo);
    return { ok: result.ok, output: result.stdout.slice(-2000) };
  }

  async gitBranches(
    sandbox: { id: string; status: string; repoUrl: string | null },
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
    sandbox: { id: string; status: string; repoUrl: string | null },
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
    sandbox: { id: string; status: string; repoUrl: string | null },
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
    sandbox: { id: string; status: string; repoUrl: string | null },
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
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo: string | undefined,
    file: string
  ): Promise<{ content: string; truncated: boolean }> {
    this.validateFile(file);
    const result = await this.run(sandbox, `head -c 512001 -- ${this.q(file)} | base64 -w0`, repo);
    if (!result.ok) throw new BadRequestException('Could not read that file');
    const content = Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
    return {
      content: content.slice(0, 512000),
      truncated: content.length > 512000
    };
  }

  async writeFile(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo: string | undefined,
    file: string,
    content: string
  ): Promise<{ ok: boolean }> {
    this.validateFile(file);
    if (typeof content !== 'string' || content.length > 512000) {
      throw new BadRequestException('File content must be a string up to 500KB');
    }
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const result = await this.run(
      sandbox,
      `mkdir -p "$(dirname ${this.q(file)})"; printf '%s' ${this.q(b64)} | base64 -d > ${this.q(file)}`,
      repo
    );
    if (!result.ok) throw new BadRequestException('Could not write that file');
    return { ok: true };
  }

  async bootStatus(sandbox: {
    id: string;
    status: string;
  }): Promise<{ phase: string; ready: boolean; label: string }> {
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
      const result = await this.k8s.execCapture(
        sandbox.id,
        ['/bin/sh', '-c', `cat ${SANDBOX_PHASE_FILE} 2>/dev/null`],
        8000
      );
      const value = result.stdout.trim();
      if (value) phase = value;
    } catch {
      return { phase: 'starting', ready: false, label: labels.starting };
    }
    return { phase, ready: phase === 'ready', label: labels[phase] || 'Setting up' };
  }

  async listRepos(sandbox: {
    id: string;
    status: string;
    repoUrl: string | null;
  }): Promise<{ repos: SandboxRepo[] }> {
    if (sandbox.status !== 'running') {
      throw new BadRequestException('Sandbox is not running');
    }
    const script = [
      'for d in /persist/home/*/.git; do',
      '  [ -e "$d" ] || continue',
      '  r="${d%/.git}"',
      '  b=$(git -C "$r" rev-parse --abbrev-ref HEAD 2>/dev/null)',
      '  n=$(git -C "$r" status --porcelain 2>/dev/null | wc -l)',
      '  echo "${r##*/}|$b|$n"',
      'done'
    ].join('\n');
    const result = await this.k8s.execCapture(sandbox.id, ['su', '-l', 'dev', '-c', script]);
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

  async addRepo(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repoUrl: string
  ): Promise<{ name: string }> {
    if (sandbox.status !== 'running') {
      throw new BadRequestException('Sandbox is not running');
    }
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
      `[ -e '${target}' ] && exit 4`,
      `nohup git clone '${parsed.href}' '${target}' >> /persist/home/.clone.log 2>&1 &`,
      'exit 0'
    ].join('\n');
    const result = await this.k8s.execCapture(sandbox.id, ['su', '-l', 'dev', '-c', script]);
    if (!result.ok) {
      throw new BadRequestException(`A directory named "${name}" already exists in the sandbox`);
    }
    return { name };
  }

  private async proxyOpencodeViaExec(
    sandbox: { id: string },
    req: Request,
    res: Response,
    suffix: string,
    query: string,
    payload: string | null
  ): Promise<void> {
    if (!this.kubernetes.kc) {
      res.status(502).json({ message: 'Kubernetes is not configured' });
      return;
    }
    const pod = await this.k8s.runningPod(sandbox.id);
    if (!pod) {
      res.status(502).json({ message: 'Sandbox pod is not running' });
      return;
    }
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const isSse = String(req.headers.accept || '').includes('text/event-stream');
    let curl = `curl -si -N -X ${req.method} ${q(`http://127.0.0.1:4096/${suffix}${query}`)} -H ${q(`accept: ${req.headers.accept || 'application/json'}`)}`;
    if (payload) curl += ` -H 'content-type: application/json' --data-binary ${q(payload)}`;
    if (!isSse) curl += ' -m 110';
    const stdout = new PassThrough();
    let headerBuffer = '';
    let headersDone = false;
    stdout.on('data', (chunk: Buffer) => {
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
    const exec = new k8s.Exec(this.kubernetes.kc);
    let execWs: any = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (!headersDone && !res.headersSent) {
        res.status(502).json({ message: 'opencode is not reachable in this sandbox' });
        return;
      }
      res.end();
    };
    res.on('close', () => {
      try {
        execWs?.close();
      } catch {}
    });
    try {
      execWs = await exec.exec(
        this.k8s.namespace,
        pod.name,
        'sandbox',
        ['su', '-l', 'dev', '-c', curl],
        stdout,
        null,
        null,
        false,
        () => finish()
      );
    } catch (e: any) {
      this.logger.warn(`opencode exec proxy failed for ${sandbox.id}: ${e?.message}`);
      finish();
    }
  }

  async changes(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo?: string
  ): Promise<SandboxChanges> {
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
    sandbox: { id: string; status: string; repoUrl: string | null },
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
