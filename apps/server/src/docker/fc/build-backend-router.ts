import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from '../../analytics/analytics.service';
import { FirecrackerClient } from './fc-client';

export type BuilderKind = 'kubernetes' | 'depot' | 'firecracker';

export const BUILDER_KINDS: readonly BuilderKind[] = ['kubernetes', 'depot', 'firecracker'];

export const BUILDER_OVERRIDES = ['firecracker', 'kubernetes'] as const;

export type BuilderOverride = (typeof BUILDER_OVERRIDES)[number];

export const FIRECRACKER_FLAG = 'firecracker-builder';

export function isBuilderOverride(value: unknown): value is BuilderOverride {
  return typeof value === 'string' && (BUILDER_OVERRIDES as readonly string[]).includes(value);
}

export function isBuilderKind(value: unknown): value is BuilderKind {
  return typeof value === 'string' && (BUILDER_KINDS as readonly string[]).includes(value);
}

export function decideBuilder(input: {
  buildWithDepot: boolean;
  override: string | null;
  firecrackerAvailable: boolean;
  flag: () => Promise<boolean>;
}): Promise<BuilderKind> | BuilderKind {
  if (input.buildWithDepot) return 'depot';
  if (!input.firecrackerAvailable || input.override === 'kubernetes') return 'kubernetes';
  if (input.override === 'firecracker') return 'firecracker';
  return input.flag().then(
    (on) => (on ? 'firecracker' : 'kubernetes'),
    () => 'kubernetes'
  );
}

export function builderPoolOf(
  run: { builder: string | null },
  buildWithDepot: boolean
): BuilderKind {
  if (isBuilderKind(run.builder)) return run.builder;
  return buildWithDepot ? 'depot' : 'kubernetes';
}

const FLAG_TIMEOUT_MS = 2_000;

@Injectable()
export class BuildBackendRouter {
  private readonly logger = new Logger(BuildBackendRouter.name);

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly firecracker: FirecrackerClient
  ) {}

  async pick(deployment: {
    buildWithDepot: boolean;
    builderOverride: string | null;
    projectId: string;
    projectSlug?: string | null;
    organizationId: string;
    organizationSlug?: string | null;
  }): Promise<BuilderKind> {
    return decideBuilder({
      buildWithDepot: deployment.buildWithDepot,
      override: deployment.builderOverride,
      firecrackerAvailable: this.firecracker.enabled,
      flag: () => this.flag(deployment)
    });
  }

  private async flag(deployment: {
    projectId: string;
    projectSlug?: string | null;
    organizationId: string;
    organizationSlug?: string | null;
  }): Promise<boolean> {
    const evaluation = this.analytics.isFeatureEnabled(
      FIRECRACKER_FLAG,
      `project:${deployment.projectId}`,
      {
        groups: { organization: deployment.organizationId },
        personProperties: {
          project_id: deployment.projectId,
          project_slug: deployment.projectSlug ?? '',
          org_id: deployment.organizationId,
          org_slug: deployment.organizationSlug ?? ''
        }
      }
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), FLAG_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([evaluation, timeout]);
    } catch (error) {
      this.logger.warn(`${FIRECRACKER_FLAG} evaluation failed: ${(error as Error).message}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
