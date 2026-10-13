import type { MirrorListPage } from '@orchard/graft-sdk/server';

export type MirrorEventType = 'add' | 'update' | 'delete';

export interface MirrorRefs {
  deploymentId?: string | null;
  projectId?: string | null;
  databaseId?: string | null;
  jobId?: string | null;
}

export interface MirrorObjectKey {
  namespace: string;
  name: string;
  refs: MirrorRefs | null;
}

export interface K8sListBody {
  body: {
    items?: any[];
    metadata?: { resourceVersion?: string; _continue?: string; continue?: string };
  };
}

export function stripSecretData(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  delete obj.data;
  delete obj.stringData;
  return obj;
}

export function toListResult(res: K8sListBody): MirrorListPage {
  const meta = res.body.metadata ?? {};
  return {
    items: res.body.items ?? [],
    resourceVersion: meta.resourceVersion ?? '',
    continueToken: meta._continue ?? meta.continue ?? null
  };
}
