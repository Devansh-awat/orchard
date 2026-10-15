import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { SecretCryptoService } from '../../core/secret-crypto.service';
import { refOf } from '../runners/sandbox-runner';
import { SandboxesService } from '../sandboxes.service';
import type { WorkspaceSandbox } from '../sandbox-workspace.service';
import { DaemonRpcError, DaemonUnavailableError } from './daemon-connection';
import { SandboxDaemonService } from './sandbox-daemon.service';
import {
  findSignIn,
  isLocalCallback,
  parseLoginOutput,
  publicLogins,
  type AgentLoginStep
} from './agent-logins';

interface DaemonLoginStatus {
  loginId: string;
  agent: string;
  state: 'running' | 'exited';
  exitCode?: number | null;
  output: string;
  startedAt: number;
}

export interface AgentLoginView {
  loginId: string;
  agent: string;
  method: string;
  step: AgentLoginStep;
  state: 'running' | 'succeeded' | 'failed';
  url: string | null;
  code: string | null;
  lines: string[];
  saved: boolean;
}

function wrap(e: unknown): never {
  if (e instanceof DaemonUnavailableError) {
    throw new ServiceUnavailableException('The agent host on this machine is not reachable yet');
  }
  if (e instanceof DaemonRpcError) {
    if (e.code === -32601) {
      throw new ConflictException(
        'This machine runs an older agent host. Restart the machine to sign in from here.'
      );
    }
    if (e.code === -32004) throw new NotFoundException(e.message);
    if (e.code === -32009) throw new ConflictException(e.message);
    if (e.code === -32602) throw new BadRequestException(e.message);
    if (e.code === -32010) throw new ServiceUnavailableException(e.message);
    throw new BadGatewayException(e.message);
  }
  throw e;
}

@Injectable()
export class SandboxAgentAuthService {
  private readonly logger = new Logger(SandboxAgentAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly daemon: SandboxDaemonService,
    private readonly sandboxes: SandboxesService
  ) {}

  catalog() {
    return { agents: publicLogins() };
  }

  private requireOwner(sandbox: WorkspaceSandbox, userId: string) {
    if (sandbox.userId !== userId) {
      throw new ForbiddenException("Only the machine's owner can sign its agents in");
    }
    if (sandbox.status !== 'running') {
      throw new ConflictException('Start the machine to sign in');
    }
  }

  async start(
    sandbox: WorkspaceSandbox,
    userId: string,
    agent: string,
    method: string
  ): Promise<AgentLoginView> {
    this.requireOwner(sandbox, userId);
    const signIn = findSignIn(agent, method);
    if (!signIn) throw new BadRequestException('Unknown sign-in method');
    const status = await this.daemon
      .call<DaemonLoginStatus>(
        refOf(sandbox),
        'auth.start',
        { agent, command: signIn.command },
        15_000
      )
      .catch(wrap);
    return this.view(sandbox, userId, status, method);
  }

  async status(
    sandbox: WorkspaceSandbox,
    userId: string,
    loginId: string,
    method: string
  ): Promise<AgentLoginView> {
    this.requireOwner(sandbox, userId);
    const status = await this.daemon
      .call<DaemonLoginStatus>(refOf(sandbox), 'auth.status', { loginId }, 10_000)
      .catch(wrap);
    return this.view(sandbox, userId, status, method);
  }

  async answer(
    sandbox: WorkspaceSandbox,
    userId: string,
    loginId: string,
    method: string,
    text: string
  ): Promise<AgentLoginView> {
    this.requireOwner(sandbox, userId);
    const value = (text ?? '').trim();
    if (!value) throw new BadRequestException('Paste the code or address first');
    if (value.length > 4096) throw new BadRequestException('That is too long to be a sign-in code');
    const ref = refOf(sandbox);
    if (isLocalCallback(value)) {
      await this.daemon.call(ref, 'auth.callback', { loginId, url: value }, 20_000).catch(wrap);
    } else {
      await this.daemon.call(ref, 'auth.input', { loginId, text: value }, 10_000).catch(wrap);
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    return this.status(sandbox, userId, loginId, method);
  }

  async cancel(sandbox: WorkspaceSandbox, userId: string, loginId: string) {
    this.requireOwner(sandbox, userId);
    await this.daemon.call(refOf(sandbox), 'auth.cancel', { loginId }, 10_000).catch(wrap);
    return { ok: true };
  }

  private async view(
    sandbox: WorkspaceSandbox,
    userId: string,
    status: DaemonLoginStatus,
    method: string
  ): Promise<AgentLoginView> {
    const parsed = parseLoginOutput(status.output ?? '');
    const signIn = findSignIn(status.agent, method);
    let saved = false;
    if (signIn?.saves === 'claudeToken' && parsed.token) {
      saved = await this.saveClaudeToken(sandbox, userId, parsed.token);
    }
    const exited = status.state === 'exited';
    const ok = exited && status.exitCode === 0 && (!signIn?.saves || saved);
    return {
      loginId: status.loginId,
      agent: status.agent,
      method: signIn ? method : '',
      step: signIn?.step ?? 'none',
      state: !exited ? 'running' : ok ? 'succeeded' : 'failed',
      url: parsed.url,
      code: parsed.code,
      lines: parsed.lines,
      saved
    };
  }

  private async saveClaudeToken(
    sandbox: WorkspaceSandbox,
    userId: string,
    token: string
  ): Promise<boolean> {
    const existing = await this.prisma.sandboxCredential.findUnique({
      where: { userId },
      select: { claudeToken: true }
    });
    if (existing?.claudeToken) {
      try {
        if (this.crypto.decrypt(existing.claudeToken).replace(/\s+/g, '') === token) return true;
      } catch {
        this.logger.warn(`could not read the saved Claude token for ${userId}; replacing it`);
      }
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true }
    });
    await this.sandboxes.setCredentials(userId, user?.email ?? null, { claudeToken: token });
    this.logger.log(`saved a Claude sign-in from machine ${sandbox.id} for ${userId}`);
    return true;
  }
}
