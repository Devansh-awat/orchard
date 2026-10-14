import { Injectable, Logger } from '@nestjs/common';
import { SANDBOX_PHASE_FILE } from '../sandbox-bootstrap';
import { SandboxNotRunningError, SandboxRowLike, refOf } from './sandbox-runner';
import { SandboxRunnerRegistry } from './sandbox-runner.registry';
import { OPENCODE_LOCAL_AUTH, OPENCODE_LOCAL_CURL_AUTH } from './sandbox-init-files';

export const BUSY_IGNORE = 'pgrep|opencode serve|claude-agent-acp|codex-acp|orchard sandbox';

export const BUSY_SCRIPT = `pgrep -af 'claude|codex' | grep -vE '${BUSY_IGNORE}' | head -1; ${OPENCODE_LOCAL_AUTH}; curl -s -m 3 ${OPENCODE_LOCAL_CURL_AUTH} http://127.0.0.1:4096/session/status | grep -o '"type":"busy"' | head -1`;

@Injectable()
export class SandboxProbesService {
  private readonly logger = new Logger(SandboxProbesService.name);

  constructor(private readonly registry: SandboxRunnerRegistry) {}

  private daemonBusy: ((row: SandboxRowLike) => Promise<boolean | null>) | null = null;

  setDaemonBusy(check: ((row: SandboxRowLike) => Promise<boolean | null>) | null): void {
    this.daemonBusy = check;
  }

  async isAgentBusy(row: SandboxRowLike): Promise<boolean> {
    const fromDaemon = this.daemonBusy ? await this.daemonBusy(row).catch(() => null) : null;
    if (fromDaemon === true) return true;
    try {
      const result = await this.registry
        .for(row)
        .exec(refOf(row), ['/bin/sh', '-c', BUSY_SCRIPT], { timeoutMs: 5000 });
      return result.stdout.trim().length > 0;
    } catch (e: any) {
      if (!(e instanceof SandboxNotRunningError)) {
        this.logger.warn(`busy check failed for ${row.id}: ${e?.message}`);
      }
      return false;
    }
  }

  async bootPhase(row: SandboxRowLike): Promise<string | null> {
    const result = await this.registry
      .for(row)
      .exec(refOf(row), ['/bin/sh', '-c', `cat ${SANDBOX_PHASE_FILE} 2>/dev/null`], {
        timeoutMs: 8000
      });
    return result.stdout.trim() || null;
  }
}
