import { HttpException, Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../kubernetes/kubernetes.service';

export interface ApplyItemInput {
  dedupeKey: string;
  opType: string;
  manifest: unknown;
  deploymentId: string | null;
  sandboxId?: string | null;
}

export type ApplyHandler = (item: ApplyItemInput) => Promise<void>;

export interface ApplyResult {
  ok: boolean;
  terminal?: boolean;
  error?: string;
}

@Injectable()
export class ApplyExecutorService {
  private readonly logger = new Logger(ApplyExecutorService.name);

  private readonly handlers = new Map<string, ApplyHandler>();

  constructor(private readonly kubernetes: KubernetesService) {}

  registerHandler(opType: string, handler: ApplyHandler): void {
    this.handlers.set(opType, handler);
  }

  async ssaApply(manifest: k8s.KubernetesObject): Promise<k8s.KubernetesObject> {
    this.kubernetes.ensureKubeConfig();
    const api = k8s.KubernetesObjectApi.makeApiClient(this.kubernetes.kc!);
    const res = await api.patch(manifest, undefined, undefined, 'orchard', true, {
      headers: { 'content-type': k8s.PatchUtils.PATCH_FORMAT_APPLY_YAML }
    });
    return res.body;
  }

  async execute(item: ApplyItemInput): Promise<ApplyResult> {
    try {
      if (item.opType === 'ssa') {
        await this.ssaApply(item.manifest as k8s.KubernetesObject);
        return { ok: true };
      }
      const handler = this.handlers.get(item.opType);
      if (!handler) {
        return { ok: false, terminal: true, error: `no handler for op type ${item.opType}` };
      }
      await handler(item);
      return { ok: true };
    } catch (error) {
      const status = error as { response?: { statusCode?: number }; statusCode?: number };
      const code =
        error instanceof HttpException
          ? error.getStatus()
          : (status.response?.statusCode ?? status.statusCode);
      const httpBody = error instanceof HttpException ? error.getResponse() : null;
      const message =
        (typeof httpBody === 'object' && httpBody && 'message' in httpBody
          ? String((httpBody as { message?: unknown }).message)
          : null) ??
        (error as { response?: { body?: { message?: string } } }).response?.body?.message ??
        (error as Error)?.message ??
        String(error);
      const terminal = code === 400 || code === 422;
      this.logger.warn(`apply ${item.dedupeKey} failed (${code ?? 'n/a'}): ${message}`);
      return { ok: false, terminal, error: message };
    }
  }
}
