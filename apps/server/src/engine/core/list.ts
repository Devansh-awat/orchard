import type { EngineListPage } from './informer';

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

// The typed clients deserialize ListMeta.continue to `_continue`; CustomObjectsApi
// hands back the raw JSON, where it stays `continue`.
export function toListResult(res: K8sListBody): EngineListPage {
  const meta = res.body.metadata ?? {};
  return {
    items: res.body.items ?? [],
    resourceVersion: meta.resourceVersion ?? '',
    continueToken: meta._continue ?? meta.continue ?? null
  };
}
