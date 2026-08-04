import { BadRequestException, Injectable } from '@nestjs/common';
import { SandboxK8sService, sandboxWorkdir } from './sandbox-k8s.service';

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/ @-]*$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
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
  constructor(private readonly k8s: SandboxK8sService) {}

  resolveWorkdir(
    sandbox: { repoUrl: string | null },
    repo: string | undefined,
  ): string {
    if (repo) {
      if (!REPO_RE.test(repo) || repo.includes('..')) {
        throw new BadRequestException('Invalid repo name');
      }
      return `/persist/home/${repo}`;
    }
    return sandboxWorkdir(sandbox.repoUrl);
  }

  private async run(
    sandbox: { id: string; status: string; repoUrl: string | null },
    script: string,
    repo?: string,
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
      `cd '${dir}' 2>/dev/null || exit 3; ${script}`,
    ]);
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
      '[ -e "$d" ] || continue',
      'r="${d%/.git}"',
      'b=$(git -C "$r" rev-parse --abbrev-ref HEAD 2>/dev/null)',
      'n=$(git -C "$r" status --porcelain 2>/dev/null | wc -l)',
      'echo "${r##*/}|$b|$n"',
      'done',
    ].join('; ');
    const result = await this.k8s.execCapture(sandbox.id, ['su', '-l', 'dev', '-c', script]);
    const repos: SandboxRepo[] = [];
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length !== 3 || !parts[0]) continue;
      repos.push({
        name: parts[0],
        branch: parts[1] || null,
        dirtyFiles: Number(parts[2]) || 0,
      });
    }
    return { repos };
  }

  async addRepo(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repoUrl: string,
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
    const name = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean).pop() || '';
    if (!REPO_RE.test(name)) {
      throw new BadRequestException('Could not derive a repo directory name from that URL');
    }
    const target = `/persist/home/${name}`;
    const script = [
      `[ -e '${target}' ] && exit 4`,
      `nohup git clone '${parsed.href}' '${target}' >> /persist/home/.clone.log 2>&1 &`,
      'exit 0',
    ].join('; ');
    const result = await this.k8s.execCapture(sandbox.id, ['su', '-l', 'dev', '-c', script]);
    if (!result.ok) {
      throw new BadRequestException(`A directory named "${name}" already exists in the sandbox`);
    }
    return { name };
  }

  async changes(
    sandbox: { id: string; status: string; repoUrl: string | null },
    repo?: string,
  ): Promise<SandboxChanges> {
    const script = [
      'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 3',
      'echo "@@branch@@$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
      'git status --porcelain',
      'echo "@@numstat@@"',
      'git diff --numstat HEAD 2>/dev/null',
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
        deletions: m[2] === '-' ? null : Number(m[2]),
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
        deletions: c?.deletions ?? null,
      });
    }
    return { isRepo: true, branch, files };
  }

  async diff(
    sandbox: { id: string; status: string; repoUrl: string | null },
    file: string | undefined,
    repo?: string,
  ): Promise<{ diff: string; truncated: boolean }> {
    let script: string;
    if (file) {
      if (!FILE_RE.test(file) || file.includes('..')) {
        throw new BadRequestException('Invalid file path');
      }
      script = [
        `git diff HEAD -- '${file}'`,
        `if git status --porcelain -- '${file}' | grep -q '^??'; then git diff --no-index -- /dev/null '${file}' || true; fi`,
      ].join('; ');
    } else {
      script = 'git diff HEAD';
    }
    const result = await this.run(sandbox, `{ ${script}; } | head -c ${MAX_DIFF_BYTES + 1}`, repo);
    const truncated = result.stdout.length > MAX_DIFF_BYTES;
    return {
      diff: truncated ? result.stdout.slice(0, MAX_DIFF_BYTES) : result.stdout,
      truncated,
    };
  }
}
