import { INGRESS_ADAPTERS, type IngressAdapter, type IngressTarget } from './ingress';

export const PRESENCE_WINDOW = '1d';
const CONTAINER_METRIC = 'container_memory_working_set_bytes';

export interface SignalPresence {
  namespaces: string[];
  http: Record<string, string[]>;
}

export interface PresenceQuery {
  query: string;
  label: string;
}

export function presenceQueries(
  adapters: readonly IngressAdapter[] = INGRESS_ADAPTERS,
  window = PRESENCE_WINDOW
): { namespaces: PresenceQuery; http: Record<string, PresenceQuery> } {
  return {
    namespaces: {
      query: `count by (namespace) (last_over_time(${CONTAINER_METRIC}{namespace!=""}[${window}]))`,
      label: 'namespace'
    },
    http: Object.fromEntries(
      adapters.map((a) => [
        a.id,
        {
          query: `count by (${a.presenceLabel}) (last_over_time(${a.presenceMetric}[${window}]))`,
          label: a.presenceLabel
        }
      ])
    )
  };
}

export function hasContainerSignal(presence: SignalPresence, namespace: string | null): boolean {
  return !!namespace && presence.namespaces.includes(namespace);
}

export function httpFlavors(
  presence: SignalPresence,
  target: IngressTarget,
  adapters: readonly IngressAdapter[] = INGRESS_ADAPTERS
): string[] {
  return adapters
    .filter((a) => {
      const pattern = a.presencePattern(target);
      const values = presence.http[a.id];
      if (!pattern || !values?.length) return false;
      const re = new RegExp(`^(?:${pattern})$`);
      return values.some((v) => re.test(v));
    })
    .map((a) => a.id);
}
