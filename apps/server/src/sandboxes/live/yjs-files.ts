import { PrismaService } from '../../prisma/prisma.service';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { SANDBOX_REF_SELECT, SandboxNotRunningError, refOf } from '../runners/sandbox-runner';
import { isWorktreePath, normalizeRelativePath, shellQuote } from '../sandbox-session-commands';
import { YROOM_MAX_FILE_BYTES, YRoomFileError, YRoomFiles, contentHash } from './yjs-rooms';

const GUARD_FAILED = 45;
const MISSING = 44;

function guardScript(root: string, file: string): string {
  return [
    `__root=$(realpath -e -- ${shellQuote(root)} 2>/dev/null) || exit ${MISSING}`,
    `__f=$(realpath -e -- ${shellQuote(`${root}/${file}`)} 2>/dev/null) || exit ${MISSING}`,
    `case "$__f" in "$__root"/*) ;; *) exit ${GUARD_FAILED} ;; esac`,
    `[ -f "$__f" ] || exit ${GUARD_FAILED}`
  ].join('; ');
}

export class SandboxYRoomFiles implements YRoomFiles {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SandboxRunnerRegistry
  ) {}

  private async target(sandboxId: string, sid: string, path: string) {
    const relative = normalizeRelativePath(path);
    if (!relative || relative !== path) throw new YRoomFileError('Invalid file path');
    const session = await this.prisma.sandboxConversation.findFirst({
      where: { id: sid, sandboxId, archivedAt: null },
      select: { worktreePath: true }
    });
    if (!session) throw new YRoomFileError('Session not found');
    if (!isWorktreePath(session.worktreePath)) {
      throw new YRoomFileError('This session has no worktree to edit');
    }
    const sandbox = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { ...SANDBOX_REF_SELECT, status: true }
    });
    if (!sandbox) throw new YRoomFileError('Sandbox not found');
    if (sandbox.status !== 'running') throw new YRoomFileError('Sandbox is not running');
    return {
      runner: this.registry.for(sandbox),
      ref: refOf(sandbox),
      root: session.worktreePath as string,
      relative
    };
  }

  private async run(sandboxId: string, sid: string, path: string, tail: string) {
    const { runner, ref, root, relative } = await this.target(sandboxId, sid, path);
    const script = `${guardScript(root, relative)}; ${tail}`;
    try {
      return await runner.exec(ref, ['su', 'dev', '-s', '/bin/sh', '-c', script], {
        timeoutMs: 20_000
      });
    } catch (e) {
      if (e instanceof SandboxNotRunningError) throw new YRoomFileError('Sandbox is not running');
      throw e;
    }
  }

  async read(sandboxId: string, sid: string, path: string) {
    const result = await this.run(
      sandboxId,
      sid,
      path,
      `head -c ${YROOM_MAX_FILE_BYTES + 1} -- "$__f" | base64 | tr -d '\\n'`
    );
    if (result.exitCode === MISSING) throw new YRoomFileError('That file does not exist');
    if (result.exitCode === GUARD_FAILED)
      throw new YRoomFileError('That path is not a file in this session');
    if (!result.ok) throw new Error(result.stderr.slice(0, 200) || 'read failed');
    const bytes = Buffer.from(result.stdout.trim(), 'base64');
    if (bytes.length > YROOM_MAX_FILE_BYTES) {
      throw new YRoomFileError('File is too large to edit together (500KB max)');
    }
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new YRoomFileError('Binary files cannot be edited together');
    }
    return { content, hash: contentHash(content) };
  }

  async stat(sandboxId: string, sid: string, path: string): Promise<string | null> {
    const result = await this.run(sandboxId, sid, path, `md5sum -- "$__f" | cut -d' ' -f1`);
    if (result.exitCode === MISSING || result.exitCode === GUARD_FAILED) return null;
    if (!result.ok) throw new Error(result.stderr.slice(0, 200) || 'stat failed');
    const hash = result.stdout.trim();
    return /^[0-9a-f]{32}$/.test(hash) ? hash : null;
  }

  async write(sandboxId: string, sid: string, path: string, content: string): Promise<string> {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > YROOM_MAX_FILE_BYTES) {
      throw new YRoomFileError('File is too large to save (500KB max)');
    }
    const { runner, ref, root, relative } = await this.target(sandboxId, sid, path);
    if (!runner.capabilities.execStdin) {
      const check = await runner.exec(ref, [
        'su',
        'dev',
        '-s',
        '/bin/sh',
        '-c',
        `${guardScript(root, relative)}; exit 0`
      ]);
      if (check.exitCode === MISSING) throw new YRoomFileError('That file no longer exists');
      if (!check.ok) throw new YRoomFileError('That path is not a file in this session');
      await runner.writeFiles(ref, [{ path: `${root}/${relative}`, content: bytes }], {
        asUser: 'dev'
      });
      return contentHash(content);
    }
    const write = await runner.exec(
      ref,
      ['su', 'dev', '-s', '/bin/sh', '-c', `${guardScript(root, relative)}; cat > "$__f"`],
      { stdin: bytes, timeoutMs: 30_000 }
    );
    if (write.exitCode === MISSING) throw new YRoomFileError('That file no longer exists');
    if (write.exitCode === GUARD_FAILED)
      throw new YRoomFileError('That path is not a file in this session');
    if (!write.ok) throw new YRoomFileError('Could not save that file');
    return contentHash(content);
  }
}
