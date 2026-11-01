import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ingressTlsEnabled } from '../projects/projects.utils';
import { isMutableImageTag } from '../kubernetes/trusted-images';
import {
  InstanceSettingsService,
  type ImageScannerChoice
} from '../instance-settings/instance-settings.service';
import { HarborScanClient } from './harbor-scan.client';
import { ImageScanCache, type ImageScan } from './image-scan-cache';
import { ScanQueueFullError, TrivyScanService } from './trivy-scan.service';
import {
  blankSummary,
  harborImageRef,
  postureFindings,
  type HarborImageRef,
  type PostureFinding,
  type ScanSummary,
  type Vulnerability
} from './security-report';

export type ImageSource = 'orchard' | 'external' | 'none';

export interface DeploymentSecurity {
  image: {
    ref: string | null;
    source: ImageSource;
    tag: string | null;
    digest: string | null;
    pushedAt: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    builtAt: string | null;
  };
  scan: ScanSummary & {
    canRescan: boolean;
    provider: ImageScannerChoice;
    error: string | null;
  };
  vulnerabilities: Vulnerability[] | null;
  truncated: number;
  posture: PostureFinding[];
  checkedAt: string;
}

export class ScanNotPossibleError extends Error {}

type Scan = ImageScan & { error?: string | null };

export interface ScannerOption {
  value: ImageScannerChoice;
  available: boolean;
  reason: string | null;
}

const OFF_MESSAGE =
  'Image scanning is off for this instance. A superadmin can turn it on in Admin, Instance.';

type Loaded = NonNullable<Awaited<ReturnType<SecurityService['loadDeployment']>>>;

@Injectable()
export class SecurityService {
  private readonly cache: ImageScanCache;

  constructor(
    private readonly prisma: PrismaService,
    private readonly harbor: HarborScanClient,
    private readonly trivy: TrivyScanService,
    private readonly settings: InstanceSettingsService
  ) {
    this.cache = new ImageScanCache(harbor);
  }

  loadDeployment(id: string) {
    return this.prisma.deployment.findUnique({
      where: { id },
      select: {
        id: true,
        image: true,
        githubRepo: true,
        gitConnectionId: true,
        buildContextKey: true,
        envVars: { select: { key: true, value: true, secret: true } },
        ingresses: {
          select: { host: true, tlsSecretName: true, entrypoints: true, redirectTarget: true }
        }
      }
    });
  }

  private refFor(dep: Loaded): HarborImageRef | null {
    return harborImageRef(dep.image, this.harbor.registryConfig);
  }

  private sourceOf(dep: Loaded, ref: HarborImageRef | null): ImageSource {
    if (!dep.image) return 'none';
    if (ref) return 'orchard';
    if (!this.harbor.configured && (dep.githubRepo || dep.gitConnectionId || dep.buildContextKey))
      return 'orchard';
    return 'external';
  }

  private async harborUnavailableReason(): Promise<string | null> {
    if (!this.harbor.configured) {
      return 'Harbor is not configured. Set HARBOR_USERNAME, HARBOR_PASSWORD and DOCKER_REGISTRY_PULL (or HARBOR_API_URL).';
    }
    const detected = await this.harbor.detect();
    return detected.harbor ? null : (detected.reason ?? 'Harbor is unavailable.');
  }

  async scannerOptions(): Promise<ScannerOption[]> {
    const harbor = await this.harborUnavailableReason();
    const trivy = this.trivy.unavailableReason();
    return [
      { value: 'off', available: true, reason: null },
      { value: 'harbor', available: !harbor, reason: harbor },
      { value: 'trivy', available: !trivy, reason: trivy }
    ];
  }

  async defaultScanner(): Promise<ImageScannerChoice> {
    if (this.trivy.configured) return 'trivy';
    if ((await this.harborUnavailableReason()) === null) return 'harbor';
    return 'off';
  }

  scannerState() {
    return this.settings.getImageScannerState(() => this.defaultScanner());
  }

  private async provider(): Promise<ImageScannerChoice> {
    return (await this.scannerState()).value;
  }

  private async scanFor(
    provider: ImageScannerChoice,
    dep: Loaded,
    source: ImageSource,
    ref: HarborImageRef | null
  ): Promise<Scan> {
    const empty = { vulnerabilities: null, truncated: 0, digest: null, pushedAt: null };
    if (source === 'none') return { ...empty, summary: blankSummary('unsupported', 'no_image') };
    if (provider === 'off') return { ...empty, summary: blankSummary('off') };
    if (provider === 'trivy') {
      if (!this.trivy.configured || !dep.image)
        return { ...empty, summary: blankSummary('error', 'not_configured') };
      return this.trivy.latest(dep.image);
    }
    if (source === 'external')
      return { ...empty, summary: blankSummary('unsupported', 'external_image') };
    if (!ref || !this.harbor.configured)
      return { ...empty, summary: blankSummary('error', 'not_configured') };
    return this.cache.get(ref);
  }

  private scannable(
    provider: ImageScannerChoice,
    dep: Loaded,
    source: ImageSource,
    ref: HarborImageRef | null
  ) {
    if (provider === 'trivy') return this.trivy.configured && !!dep.image;
    if (provider === 'harbor') return source === 'orchard' && !!ref && this.harbor.configured;
    return false;
  }

  private async build(
    dep: Loaded,
    scan: Scan,
    provider: ImageScannerChoice,
    source: ImageSource,
    ref: HarborImageRef | null,
    canEdit: boolean
  ): Promise<DeploymentSecurity> {
    const history = dep.image
      ? await this.prisma.imageHistory.findFirst({
          where: { deploymentId: dep.id, image: dep.image },
          orderBy: { createdAt: 'desc' },
          select: {
            commitSha: true,
            commitMessage: true,
            buildCompletedAt: true,
            createdAt: true
          }
        })
      : null;
    const s = scan.summary;
    const canRescan =
      canEdit &&
      this.scannable(provider, dep, source, ref) &&
      s.state !== 'scanning' &&
      s.state !== 'error' &&
      s.state !== 'unsupported';
    return {
      image: {
        ref: dep.image,
        source,
        tag: ref?.tag ?? null,
        digest: scan.digest ?? ref?.digest ?? null,
        pushedAt: scan.pushedAt,
        commitSha: history?.commitSha ?? null,
        commitMessage: history?.commitMessage ?? null,
        builtAt: (history?.buildCompletedAt ?? history?.createdAt)?.toISOString() ?? null
      },
      scan: { ...s, canRescan, provider, error: scan.error ?? null },
      vulnerabilities: scan.vulnerabilities,
      truncated: scan.truncated,
      posture: postureFindings({
        envVars: dep.envVars,
        image: dep.image,
        mutableTag: source === 'external' && isMutableImageTag(dep.image),
        ingresses: dep.ingresses.map((i) => ({
          host: i.host,
          tlsEnabled: ingressTlsEnabled(i),
          redirectTarget: i.redirectTarget
        }))
      }),
      checkedAt: new Date().toISOString()
    };
  }

  async report(deploymentId: string, canEdit: boolean): Promise<DeploymentSecurity> {
    const dep = await this.loadDeployment(deploymentId);
    if (!dep) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    const provider = await this.provider();
    const ref = this.refFor(dep);
    const source = this.sourceOf(dep, ref);
    const scan = await this.scanFor(provider, dep, source, ref);
    return this.build(dep, scan, provider, source, ref, canEdit);
  }

  async rescan(deploymentId: string, userId: string | null): Promise<DeploymentSecurity> {
    const dep = await this.loadDeployment(deploymentId);
    if (!dep) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    const provider = await this.provider();
    const ref = this.refFor(dep);
    const source = this.sourceOf(dep, ref);
    if (provider === 'off') throw new ScanNotPossibleError(OFF_MESSAGE);
    if (!dep.image) throw new ScanNotPossibleError('This app has no image to scan yet');
    if (provider === 'trivy') {
      if (!this.trivy.configured) {
        throw new ScanNotPossibleError('The Orchard scanner is not set up on this instance');
      }
      try {
        const scan = await this.trivy.start(dep.image, { deploymentId, userId });
        return this.build(dep, scan, provider, source, ref, true);
      } catch (err) {
        if (err instanceof ScanQueueFullError) throw new ScanNotPossibleError(err.message);
        throw err;
      }
    }
    if (source !== 'orchard' || !ref) {
      throw new ScanNotPossibleError('Harbor can only scan images Orchard builds');
    }
    if (!this.harbor.configured) {
      throw new ScanNotPossibleError('Harbor scanning is not configured on this instance');
    }
    const scan = await this.cache.rescan(ref);
    return this.build(dep, scan, provider, source, ref, true);
  }
}
