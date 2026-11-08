import { check, type DoctorCheck } from './doctor.types';

export type ProbeGroup =
  | 'control'
  | 'apiserver'
  | 'nodes'
  | 'metadata'
  | 'platform'
  | 'ingress-ports'
  | 'cross-tenant';

export type ProbeKind = 'tcp' | 'dns';

export type Outcome = 'open' | 'refused' | 'timeout' | 'unreachable' | 'dns' | 'error' | 'missing';

export type Verdict = 'blocked' | 'reached' | 'control-ok' | 'control-failed' | 'inconclusive';

export interface ProbeTarget {
  id: string;
  group: ProbeGroup;
  kind: ProbeKind;
  label: string;
  host: string;
  port: number;
  expect: 'open' | 'blocked';
}

export interface ServiceTopology {
  namespace: string;
  name: string;
  ip: string;
  ports: number[];
}

export interface PodTopology {
  namespace: string;
  name: string;
  ip: string;
  ports: number[];
}

export interface NodeTopology {
  name: string;
  addresses: string[];
}

export interface Topology {
  apiserver: { ips: string[]; ports: number[] } | null;
  nodes: NodeTopology[];
  platformServices: ServiceTopology[];
  ingressPods: PodTopology[];
  ingressServingPorts: number[];
  ingressExtraPorts: number[];
  metadataAddress: string;
  external: { host: string; port: number };
  sameNamespaceListener: { ip: string; port: number };
  otherTenantListener: { ip: string; port: number };
}

export const NODE_PORTS = [10250, 22, 6443, 50000];
export const DEFAULT_INGRESS_DEBUG_PORTS = [1024, 1042, 6060];
export const MAX_TARGETS = 160;

const SAFE_HOST = /^[A-Za-z0-9.:_-]{1,253}$/;

export function safeTarget(host: string, port: number, kind: ProbeKind): boolean {
  if (!SAFE_HOST.test(host)) return false;
  if (kind === 'dns') return true;
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function buildTargets(topology: Topology): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  const add = (target: Omit<ProbeTarget, 'id'>) => {
    if (!safeTarget(target.host, target.port, target.kind)) return;
    if (
      out.some((t) => t.host === target.host && t.port === target.port && t.kind === target.kind)
    ) {
      return;
    }
    out.push({ id: `t${out.length}`, ...target });
  };

  add({
    group: 'control',
    kind: 'dns',
    label: 'cluster DNS resolves kubernetes.default',
    host: 'kubernetes.default.svc.cluster.local',
    port: 0,
    expect: 'open'
  });
  add({
    group: 'control',
    kind: 'tcp',
    label: 'public internet on 443',
    host: topology.external.host,
    port: topology.external.port,
    expect: 'open'
  });
  add({
    group: 'control',
    kind: 'tcp',
    label: 'listener in the same namespace',
    host: topology.sameNamespaceListener.ip,
    port: topology.sameNamespaceListener.port,
    expect: 'open'
  });
  const servingPods = topology.ingressPods.filter((pod) =>
    pod.ports.some((p) => topology.ingressServingPorts.includes(p))
  );
  for (const pod of servingPods.slice(0, 1)) {
    const port = pod.ports.find((p) => topology.ingressServingPorts.includes(p));
    if (port === undefined) continue;
    add({
      group: 'control',
      kind: 'tcp',
      label: `ingress controller serving port (${pod.namespace}/${pod.name})`,
      host: pod.ip,
      port,
      expect: 'open'
    });
  }

  if (topology.apiserver) {
    const ports = uniq([...topology.apiserver.ports, 443, 6443]);
    for (const ip of topology.apiserver.ips) {
      for (const port of ports) {
        add({
          group: 'apiserver',
          kind: 'tcp',
          label: `kube-apiserver ${ip}`,
          host: ip,
          port,
          expect: 'blocked'
        });
      }
    }
  }

  for (const node of topology.nodes) {
    for (const address of node.addresses) {
      for (const port of NODE_PORTS) {
        add({
          group: 'nodes',
          kind: 'tcp',
          label: `node ${node.name}`,
          host: address,
          port,
          expect: 'blocked'
        });
      }
    }
  }

  add({
    group: 'metadata',
    kind: 'tcp',
    label: 'cloud metadata service',
    host: topology.metadataAddress,
    port: 80,
    expect: 'blocked'
  });

  for (const service of topology.platformServices) {
    for (const port of service.ports) {
      add({
        group: 'platform',
        kind: 'tcp',
        label: `service ${service.namespace}/${service.name}`,
        host: service.ip,
        port,
        expect: 'blocked'
      });
    }
  }

  const debugPorts = uniq([...DEFAULT_INGRESS_DEBUG_PORTS, ...topology.ingressExtraPorts]);
  for (const pod of topology.ingressPods) {
    const ports = uniq([...debugPorts, ...pod.ports]).filter(
      (p) => !topology.ingressServingPorts.includes(p)
    );
    for (const port of ports) {
      add({
        group: 'ingress-ports',
        kind: 'tcp',
        label: `ingress controller pod ${pod.namespace}/${pod.name}`,
        host: pod.ip,
        port,
        expect: 'blocked'
      });
    }
  }

  add({
    group: 'cross-tenant',
    kind: 'tcp',
    label: 'pod in another managed namespace',
    host: topology.otherTenantListener.ip,
    port: topology.otherTenantListener.port,
    expect: 'blocked'
  });

  return out.slice(0, MAX_TARGETS);
}

export function probeInput(targets: ProbeTarget[]): string {
  return targets.map((t) => `${t.id} ${t.kind} ${t.host} ${t.port}`).join('\n');
}

export const PROBE_TIMEOUT_SECONDS = 3;

export function probeScript(): string {
  return `
probe() {
  id="$1"; kind="$2"; host="$3"; port="$4"
  if [ "$kind" = "dns" ]; then
    if getent hosts "$host" >/dev/null 2>&1; then echo "RESULT $id open"; else echo "RESULT $id dns"; fi
    return
  fi
  err=$(timeout ${PROBE_TIMEOUT_SECONDS + 1} bash -c 'exec 3<>/dev/tcp/$1/$2' _ "$host" "$port" 2>&1)
  rc=$?
  if [ "$rc" = "0" ]; then echo "RESULT $id open"
  elif [ "$rc" = "124" ] || [ "$rc" = "137" ]; then echo "RESULT $id timeout"
  else
    case "$err" in
      *efused*) echo "RESULT $id refused" ;;
      *nreachable*|*"No route"*) echo "RESULT $id unreachable" ;;
      *"not known"*|*"ame or service"*|*"nvalid"*) echo "RESULT $id dns" ;;
      *"timed out"*) echo "RESULT $id timeout" ;;
      *) echo "RESULT $id error" ;;
    esac
  fi
}
n=0
while read -r id kind host port; do
  [ -z "$id" ] && continue
  probe "$id" "$kind" "$host" "$port" &
  n=$((n+1))
  if [ $((n % 16)) = 0 ]; then wait; fi
done <<EOF
$PROBE_TARGETS
EOF
wait
echo "DONE"
`;
}

export interface ParsedLog {
  done: boolean;
  outcomes: Map<string, Outcome>;
}

const OUTCOMES = new Set<string>(['open', 'refused', 'timeout', 'unreachable', 'dns', 'error']);

export function parseProbeLog(log: string): ParsedLog {
  const outcomes = new Map<string, Outcome>();
  let done = false;
  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'DONE') {
      done = true;
      continue;
    }
    const match = /^RESULT (t\d+) ([a-z]+)$/.exec(trimmed);
    if (match && OUTCOMES.has(match[2]) && !outcomes.has(match[1])) {
      outcomes.set(match[1], match[2] as Outcome);
    }
  }
  return { done, outcomes };
}

export function verdictFor(target: ProbeTarget, outcome: Outcome): Verdict {
  if (target.expect === 'open') return outcome === 'open' ? 'control-ok' : 'control-failed';
  if (outcome === 'open' || outcome === 'refused') return 'reached';
  if (outcome === 'timeout' || outcome === 'unreachable') return 'blocked';
  return 'inconclusive';
}

export interface TargetResult {
  id: string;
  group: ProbeGroup;
  label: string;
  host: string;
  port: number;
  expect: 'open' | 'blocked';
  outcome: Outcome;
  verdict: Verdict;
}

export function resolveTargets(
  targets: ProbeTarget[],
  parsed: ParsedLog | null,
  extra: Map<string, Outcome> = new Map()
): TargetResult[] {
  return targets.map((target) => {
    const outcome: Outcome = extra.get(target.id) ?? parsed?.outcomes.get(target.id) ?? 'missing';
    const verdict: Verdict = outcome === 'missing' ? 'inconclusive' : verdictFor(target, outcome);
    return {
      id: target.id,
      group: target.group,
      label: target.label,
      host: target.host,
      port: target.port,
      expect: target.expect,
      outcome,
      verdict: target.expect === 'open' && outcome === 'missing' ? 'control-failed' : verdict
    };
  });
}

const GROUP_CHECKS: Record<
  Exclude<ProbeGroup, 'control'>,
  { id: string; title: string; fix: string }
> = {
  apiserver: {
    id: 'selftest-apiserver',
    title: 'Tenant pod cannot reach the kube-apiserver',
    fix: 'Enforce NetworkPolicy (see cni-enforcement), add the apiserver or its load balancer address to tenant.extraDenyCidrs, and on Cilium keep the kube-apiserver entity deny.'
  },
  nodes: {
    id: 'selftest-nodes',
    title: 'Tenant pod cannot reach node management ports',
    fix: 'Firewall 10250, 22, 6443 and 50000 on the nodes from the pod network, add node addresses to tenant.extraDenyCidrs, and on Cilium keep the host and remote-node entity denies.'
  },
  metadata: {
    id: 'selftest-metadata',
    title: 'Tenant pod cannot reach the cloud metadata service',
    fix: 'Keep 169.254.0.0/16 in the tenant egress except list and block the metadata address at the cloud (IMDSv2 hop limit 1).'
  },
  platform: {
    id: 'selftest-platform',
    title: 'Tenant pod cannot reach the server, Postgres or Redis',
    fix: 'Enforce NetworkPolicy and keep networkPolicy.platform.enabled=true so platform namespaces accept connections only from non-tenant namespaces.'
  },
  'ingress-ports': {
    id: 'selftest-ingress-ports',
    title: 'Tenant pod cannot reach ingress controller metrics and debug ports',
    fix: 'Keep tenant egress to the ingress namespaces limited to the serving ports (TENANT_INGRESS_PORTS) and bind controller stats and pprof to localhost where the controller allows.'
  },
  'cross-tenant': {
    id: 'selftest-cross-tenant',
    title: 'Tenant pod cannot reach a pod in another tenant namespace',
    fix: 'Enforce NetworkPolicy, and check that the destination namespace carries default-deny-all with ingress limited to its own namespace and the ingress controller.'
  }
};

function describe(results: TargetResult[]): string {
  const shown = results
    .slice(0, 8)
    .map((r) => `${r.host}:${r.port} (${r.outcome})`)
    .join(', ');
  return results.length > 8 ? `${shown} and ${results.length - 8} more` : shown;
}

export function checksFromResults(results: TargetResult[]): DoctorCheck[] {
  const controls = results.filter((r) => r.group === 'control');
  const failedControls = controls.filter((r) => r.verdict === 'control-failed');
  const checks: DoctorCheck[] = [];
  const controlsOk = failedControls.length === 0 && controls.length > 0;
  if (controls.length === 0) {
    checks.push(
      check(
        'selftest-controls',
        'Self-test positive controls',
        'unknown',
        'No positive controls ran.',
        'Re-run the self-test.'
      )
    );
  } else if (!controlsOk) {
    checks.push(
      check(
        'selftest-controls',
        'Self-test positive controls',
        'unknown',
        `The probe could not reach things it must reach, so a blocked result would prove nothing: ${failedControls.map((r) => `${r.label} (${r.outcome})`).join('; ')}.`,
        'Check the probe image can be pulled, the tenant RuntimeClass can start the pod, and tenant egress allows DNS and the internet. Then run again.'
      )
    );
  } else {
    checks.push(
      check(
        'selftest-controls',
        'Self-test positive controls',
        'pass',
        `${controls.length} positive controls reached their targets, so the probe works.`
      )
    );
  }

  for (const group of Object.keys(GROUP_CHECKS) as Exclude<ProbeGroup, 'control'>[]) {
    const meta = GROUP_CHECKS[group];
    const members = results.filter((r) => r.group === group);
    if (members.length === 0) {
      checks.push(
        check(
          meta.id,
          meta.title,
          'unknown',
          'No targets of this kind were discovered in the cluster.',
          meta.fix
        )
      );
      continue;
    }
    const reached = members.filter((r) => r.verdict === 'reached');
    if (reached.length > 0) {
      checks.push(
        check(
          meta.id,
          meta.title,
          'fail',
          `A temporary tenant namespace pod connected to: ${describe(reached)}.`,
          meta.fix
        )
      );
      continue;
    }
    if (!controlsOk) {
      checks.push(
        check(
          meta.id,
          meta.title,
          'unknown',
          'Positive controls failed, so no verdict is possible.',
          meta.fix
        )
      );
      continue;
    }
    const inconclusive = members.filter((r) => r.verdict === 'inconclusive');
    if (inconclusive.length > 0) {
      checks.push(
        check(
          meta.id,
          meta.title,
          'unknown',
          `${inconclusive.length} of ${members.length} probes gave no usable answer: ${describe(inconclusive)}.`,
          meta.fix
        )
      );
      continue;
    }
    checks.push(
      check(meta.id, meta.title, 'pass', `All ${members.length} connection attempts were dropped.`)
    );
  }
  return checks;
}
