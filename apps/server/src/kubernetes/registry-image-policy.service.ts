import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';
import { LeaseService } from '../coordination/lease.service';
import { KubernetesService } from './kubernetes.service';
import {
  REGISTRY_FOREIGN_ANNOTATION,
  REGISTRY_OWN_ANNOTATION,
  REGISTRY_POLICY_NAME,
  REGISTRY_PREFIX_LABEL,
  namespaceRegistryMeta,
  registryImagePolicy,
  registryImagePolicyBinding,
  registryPolicyMode,
  repoFromImage
} from './registry-image-policy';

const GROUP = 'admissionregistration.k8s.io';
const VERSION = 'v1';
const RECONCILE_MS = 5 * 60 * 1000;

@Injectable()
export class RegistryImagePolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryImagePolicyService.name);

  private timer: NodeJS.Timeout | null = null;

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly lease: LeaseService
  ) {}

  onModuleInit(): void {
    if (!this.lease.canCoordinate) return;
    setTimeout(() => {
      this.tick().catch(() => {});
    }, 10_000).unref?.();
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, RECONCILE_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcile();
    } catch (e: any) {
      this.logger.warn(`tenant image policy reconcile skipped: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  async reconcile(): Promise<void> {
    const mode = registryPolicyMode(process.env.REGISTRY_IMAGE_POLICY);
    const hosts = [process.env.DOCKER_REGISTRY_PULL, process.env.DOCKER_REGISTRY_PUSH]
      .filter((host): host is string => Boolean(host))
      .map((host) => host.toLowerCase().replace(/:443$/, ''));
    const { kc } = this.kubernetes;
    if (!kc) return;
    const custom = kc.makeApiClient(k8s.CustomObjectsApi);
    if (mode === 'off' || hosts.length === 0) {
      await this.remove(custom);
      return;
    }
    await this.syncNamespaces(kc);
    await this.upsert(
      custom,
      'validatingadmissionpolicies',
      registryImagePolicy(hosts, process.env.REGISTRY_PROJECT || 'orchard')
    );
    await this.upsert(
      custom,
      'validatingadmissionpolicybindings',
      registryImagePolicyBinding(mode)
    );
  }

  private async syncNamespaces(kc: k8s.KubeConfig): Promise<void> {
    const projects = await this.prisma.project.findMany({
      select: {
        namespace: true,
        environments: { select: { namespace: true } },
        deployments: {
          select: { image: true, imageHistory: { select: { image: true } } }
        }
      }
    });
    const wanted = namespaceRegistryMeta(
      projects.map((project) => ({
        namespace: project.namespace,
        environments: project.environments.map((env) => env.namespace),
        repos: project.deployments.flatMap((deployment) =>
          [deployment.image, ...deployment.imageHistory.map((entry) => entry.image)]
            .filter((image): image is string => Boolean(image))
            .map(repoFromImage)
        )
      }))
    );
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const live = await core.listNamespace();
    for (const ns of live.body.items) {
      const name = ns.metadata?.name;
      const meta = name ? wanted.get(name) : undefined;
      if (!name || !meta) continue;
      const annotations = ns.metadata?.annotations ?? {};
      if (
        ns.metadata?.labels?.[REGISTRY_PREFIX_LABEL] === meta.prefix &&
        (annotations[REGISTRY_FOREIGN_ANNOTATION] ?? null) === meta.foreign &&
        (annotations[REGISTRY_OWN_ANNOTATION] ?? null) === meta.own
      ) {
        continue;
      }
      await core
        .patchNamespace(
          name,
          {
            metadata: {
              labels: { [REGISTRY_PREFIX_LABEL]: meta.prefix },
              annotations: {
                [REGISTRY_FOREIGN_ANNOTATION]: meta.foreign,
                [REGISTRY_OWN_ANNOTATION]: meta.own
              }
            }
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        )
        .catch((e: any) =>
          this.logger.warn(`couldn't label namespace ${name}: ${e?.body?.message ?? e?.message}`)
        );
    }
  }

  private async upsert(custom: k8s.CustomObjectsApi, plural: string, body: object): Promise<void> {
    try {
      const existing = await custom.getClusterCustomObject(
        GROUP,
        VERSION,
        plural,
        REGISTRY_POLICY_NAME
      );
      const resourceVersion = (existing.body as any)?.metadata?.resourceVersion;
      await custom.replaceClusterCustomObject(GROUP, VERSION, plural, REGISTRY_POLICY_NAME, {
        ...body,
        metadata: { name: REGISTRY_POLICY_NAME, resourceVersion }
      });
    } catch (e: any) {
      if (e?.statusCode !== 404 && e?.response?.statusCode !== 404) throw e;
      await custom.createClusterCustomObject(GROUP, VERSION, plural, body);
    }
  }

  private async remove(custom: k8s.CustomObjectsApi): Promise<void> {
    for (const plural of ['validatingadmissionpolicybindings', 'validatingadmissionpolicies']) {
      await custom
        .deleteClusterCustomObject(GROUP, VERSION, plural, REGISTRY_POLICY_NAME)
        .catch((e: any) => {
          if (e?.statusCode !== 404 && e?.response?.statusCode !== 404) throw e;
        });
    }
  }
}
