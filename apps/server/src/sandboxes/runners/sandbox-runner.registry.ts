import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InstanceConfigService } from '../../instance-config/instance-config.service';
import { SANDBOX_RUNNERS } from '../../instance-config/instance-config.sections';
import {
  SANDBOX_RUNNER_IDS,
  SandboxRunner,
  SandboxRunnerCapabilities,
  SandboxRunnerId,
  isSandboxRunnerId
} from './sandbox-runner';

export const SANDBOX_RUNNER_PROVIDERS = Symbol('SANDBOX_RUNNER_PROVIDERS');

const ENABLED_FIELD: Record<SandboxRunnerId, string> = {
  kubernetes: 'kubernetesEnabled',
  vercel: 'vercelEnabled'
};

export interface SandboxRunnerDescription {
  id: SandboxRunnerId;
  label: string;
  capabilities: SandboxRunnerCapabilities;
  available: boolean;
  reason: string | null;
}

export interface SandboxRunnersDescription {
  runners: SandboxRunnerDescription[];
  defaultRunner: SandboxRunnerId | null;
}

@Injectable()
export class SandboxRunnerRegistry {
  private readonly byId: Map<SandboxRunnerId, SandboxRunner>;

  constructor(
    @Inject(SANDBOX_RUNNER_PROVIDERS) runners: SandboxRunner[],
    private readonly config: InstanceConfigService
  ) {
    this.byId = new Map(runners.map((runner) => [runner.id, runner]));
  }

  for(row: { runner: SandboxRunnerId | string }): SandboxRunner {
    const runner = isSandboxRunnerId(row.runner) ? this.byId.get(row.runner) : undefined;
    if (!runner) {
      throw new BadRequestException(`Sandbox runner ${row.runner} is not available on this server`);
    }
    return runner;
  }

  get(id: SandboxRunnerId): SandboxRunner | null {
    return this.byId.get(id) ?? null;
  }

  all(): SandboxRunner[] {
    return SANDBOX_RUNNER_IDS.map((id) => this.byId.get(id)).filter(
      (runner): runner is SandboxRunner => !!runner
    );
  }

  enabled(id: SandboxRunnerId): boolean {
    return this.config.flag(SANDBOX_RUNNERS, ENABLED_FIELD[id]);
  }

  private unavailableReason(runner: SandboxRunner): string | null {
    if (!this.enabled(runner.id)) return `${runner.label} sandboxes are turned off on this server`;
    return runner.configError();
  }

  describe(): SandboxRunnersDescription {
    const runners = this.all().map((runner) => {
      const reason = this.unavailableReason(runner);
      return {
        id: runner.id,
        label: runner.label,
        capabilities: runner.capabilities,
        available: reason === null,
        reason
      };
    });
    const available = runners.filter((r) => r.available);
    const configured = this.config.value(SANDBOX_RUNNERS, 'defaultRunner');
    const preferred = available.find((r) => r.id === configured) ?? available[0] ?? null;
    return { runners, defaultRunner: preferred?.id ?? null };
  }

  resolveForCreate(requested?: string | null): SandboxRunner {
    if (requested !== undefined && requested !== null && requested !== '') {
      if (!isSandboxRunnerId(requested)) {
        throw new BadRequestException(`Unknown sandbox runner "${requested}"`);
      }
      const runner = this.byId.get(requested);
      if (!runner) {
        throw new BadRequestException(`The ${requested} runner is not installed on this server`);
      }
      const reason = this.unavailableReason(runner);
      if (reason) throw new BadRequestException(reason);
      return runner;
    }
    const { defaultRunner, runners } = this.describe();
    if (!defaultRunner) {
      const reasons = runners.map((r) => r.reason).filter(Boolean);
      throw new BadRequestException(
        reasons.length
          ? `No sandbox runner is available: ${reasons.join('; ')}`
          : 'No sandbox runner is available on this server'
      );
    }
    return this.byId.get(defaultRunner)!;
  }
}
