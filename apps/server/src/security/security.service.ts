import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ingressTlsEnabled } from '../projects/projects.utils';
import { isMutableImageTag } from '../kubernetes/trusted-images';
import { HarborScanClient } from './harbor-scan.client';
import { ImageScanCache, type ImageScan } from './image-scan-cache';
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
  scan: ScanSummary & { canRescan: boolean };
  vulnerabilities: Vulnerability[] | null;
  truncated: number;
  posture: PostureFinding[];
  checkedAt: string;
}

export class ScanNotPossibleError extends Error {}

type Loaded = NonNullable<Awaited<ReturnType<SecurityService['loadDeployment']>>>;

@Injectable()
export class SecurityService {
  private readonly cache: ImageScanCache;

  constructor(
    private readonly prisma: PrismaService,
    private readonly harbor: HarborScanClient
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

  private async scanFor(source: ImageSource, ref: HarborImageRef | null): Promise<ImageScan> {
    const empty = { vulnerabilities: null, truncated: 0, digest: null, pushedAt: null };
    if (source === 'none') return { ...empty, summary: blankSummary('unsupported', 'no_image') };
    if (source === 'external')
      return { ...empty, summary: blankSummary('unsupported', 'external_image') };
    if (!ref || !this.harbor.configured)
      return { ...empty, summary: blankSummary('error', 'not_configured') };
    return this.cache.get(ref);
  }

  private async build(
    dep: Loaded,
    scan: ImageScan,
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
      source === 'orchard' &&
      this.harbor.configured &&
      !!ref &&
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
      scan: { ...s, canRescan },
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
    const ref = this.refFor(dep);
    const source = this.sourceOf(dep, ref);
    return this.build(dep, await this.scanFor(source, ref), source, ref, canEdit);
  }

  async rescan(deploymentId: string): Promise<DeploymentSecurity> {
    const dep = await this.loadDeployment(deploymentId);
    if (!dep) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    const ref = this.refFor(dep);
    const source = this.sourceOf(dep, ref);
    if (source !== 'orchard' || !ref) {
      throw new ScanNotPossibleError('Only images Orchard builds can be scanned');
    }
    if (!this.harbor.configured) {
      throw new ScanNotPossibleError('Image scanning is not configured on this instance');
    }
    const scan = await this.cache.rescan(ref);
    return this.build(dep, scan, source, ref, true);
  }
}
