import {
  MANAGED_DATABASE_IMAGE,
  podResourcesFor,
  type OrgPodDefaults
} from '../kubernetes/presets';

export type AllowanceSource = 'explicit' | 'default' | 'unlimited';

export interface MemberAllowanceRow {
  cpuAllowanceMilli: number | null;
  memoryAllowanceBytes: bigint | number | null;
  cpuAllowanceUnlimited: boolean;
  memoryAllowanceUnlimited: boolean;
}

export interface OrgDefaults {
  defaultMemberCpuMilli: number | null;
  defaultMemberMemoryBytes: bigint | number | null;
}

export interface MemberAllowance {
  cpuMilli: number | null;
  memoryBytes: number | null;
  source: { cpu: AllowanceSource; memory: AllowanceSource };
}

export function memberAllowance(member: MemberAllowanceRow, org: OrgDefaults): MemberAllowance {
  let cpu: number | null;
  let cpuSource: AllowanceSource;
  if (member.cpuAllowanceUnlimited) {
    cpu = null;
    cpuSource = 'unlimited';
  } else if (member.cpuAllowanceMilli !== null) {
    cpu = member.cpuAllowanceMilli;
    cpuSource = 'explicit';
  } else if (org.defaultMemberCpuMilli !== null) {
    cpu = org.defaultMemberCpuMilli;
    cpuSource = 'default';
  } else {
    cpu = null;
    cpuSource = 'unlimited';
  }
  let mem: number | null;
  let memSource: AllowanceSource;
  if (member.memoryAllowanceUnlimited) {
    mem = null;
    memSource = 'unlimited';
  } else if (member.memoryAllowanceBytes !== null) {
    mem = Number(member.memoryAllowanceBytes);
    memSource = 'explicit';
  } else if (org.defaultMemberMemoryBytes !== null) {
    mem = Number(org.defaultMemberMemoryBytes);
    memSource = 'default';
  } else {
    mem = null;
    memSource = 'unlimited';
  }
  return { cpuMilli: cpu, memoryBytes: mem, source: { cpu: cpuSource, memory: memSource } };
}

export interface OwnedProject {
  id: string;
  name: string;
  deployments: {
    id: string;
    name: string;
    cpuRequestMilli: number | null;
    memoryRequestBytes: bigint | number | null;
    replicas: number | null;
    stopped: boolean;
  }[];
  databases: {
    id: string;
    name: string;
    cpuRequestMilli: number | null;
    memoryRequestBytes: bigint | number | null;
    replicas: number | null;
  }[];
}

export interface UsageLine {
  kind: 'deployment' | 'database' | 'templateInstance';
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  cpuMilli: number;
  memoryBytes: number;
  replicas: number;
}

export function ownedUsage(
  projects: OwnedProject[],
  excludeDeploymentId?: string
): { cpuMilli: number; memoryBytes: number; breakdown: UsageLine[] } {
  let cpu = 0;
  let mem = 0;
  const breakdown: UsageLine[] = [];
  for (const p of projects) {
    for (const d of p.deployments) {
      if (excludeDeploymentId && d.id === excludeDeploymentId) continue;
      const replicas = d.stopped ? 0 : (d.replicas ?? 1);
      const c = (d.cpuRequestMilli ?? 0) * replicas;
      const m = (d.memoryRequestBytes ? Number(d.memoryRequestBytes) : 0) * replicas;
      cpu += c;
      mem += m;
      breakdown.push({
        kind: 'deployment',
        id: d.id,
        name: d.name,
        projectId: p.id,
        projectName: p.name,
        cpuMilli: c,
        memoryBytes: m,
        replicas
      });
    }
    for (const db of p.databases) {
      const instances = Math.max(1, db.replicas ?? 1);
      const c = (db.cpuRequestMilli ?? 0) * instances;
      const m = (db.memoryRequestBytes ? Number(db.memoryRequestBytes) : 0) * instances;
      cpu += c;
      mem += m;
      breakdown.push({
        kind: 'database',
        id: db.id,
        name: db.name,
        projectId: p.id,
        projectName: p.name,
        cpuMilli: c,
        memoryBytes: m,
        replicas: instances
      });
    }
  }
  return { cpuMilli: cpu, memoryBytes: mem, breakdown };
}

export interface CommitmentOverrides {
  memberOverride?: {
    userId: string;
    cpuMilli: number | null;
    memoryBytes: number | null;
    cpuUnlimited: boolean;
    memoryUnlimited: boolean;
  };
  defaultOverride?: {
    cpuMilli: number | null;
    memoryBytes: number | null;
  };
}

export function allowanceCommitment(
  org: OrgDefaults & { members: (MemberAllowanceRow & { userId: string })[] },
  overrides?: CommitmentOverrides
): { cpuMilli: number; memoryBytes: number } {
  const defaultCpu =
    overrides?.defaultOverride?.cpuMilli !== undefined
      ? overrides.defaultOverride.cpuMilli
      : org.defaultMemberCpuMilli;
  let defaultMem: number | null = org.defaultMemberMemoryBytes
    ? Number(org.defaultMemberMemoryBytes)
    : null;
  if (overrides?.defaultOverride?.memoryBytes !== undefined) {
    defaultMem = overrides.defaultOverride.memoryBytes;
  }
  let cpu = 0;
  let mem = 0;
  for (const m of org.members) {
    const override =
      overrides?.memberOverride?.userId === m.userId ? overrides.memberOverride : null;
    const cpuUnlimited = override ? override.cpuUnlimited : m.cpuAllowanceUnlimited;
    const memUnlimited = override ? override.memoryUnlimited : m.memoryAllowanceUnlimited;
    const cpuExplicit = override ? override.cpuMilli : m.cpuAllowanceMilli;
    let memExplicit: number | null = null;
    if (override) memExplicit = override.memoryBytes;
    else if (m.memoryAllowanceBytes) memExplicit = Number(m.memoryAllowanceBytes);
    if (!cpuUnlimited) {
      if (cpuExplicit !== null) cpu += cpuExplicit;
      else if (defaultCpu !== null) cpu += defaultCpu;
    }
    if (!memUnlimited) {
      if (memExplicit !== null) mem += memExplicit;
      else if (defaultMem !== null) mem += defaultMem;
    }
  }
  return { cpuMilli: cpu, memoryBytes: mem };
}

export function groupByOwner<T extends { ownerId: string | null }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.ownerId) continue;
    const bucket = out.get(row.ownerId);
    if (bucket) bucket.push(row);
    else out.set(row.ownerId, [row]);
  }
  return out;
}

export interface ProjectWorkloads {
  deployments: {
    id: string;
    image: string | null;
    cpuRequestMilli: number | null;
    memoryRequestBytes: bigint | number | null;
    replicas: number | null;
    stopped: boolean;
  }[];
  databases: {
    status: string | null;
    cpuRequestMilli: number | null;
    memoryRequestBytes: bigint | number | null;
    replicas: number | null;
  }[];
}

export function declaredProjectUsage(
  project: ProjectWorkloads,
  org: OrgPodDefaults,
  excludeDeploymentId?: string
): { cpuMilli: number; memoryBytes: number; pods: number } {
  const usage = { cpuMilli: 0, memoryBytes: 0, pods: 0 };
  const add = (
    image: string | null,
    row: { cpuRequestMilli: number | null; memoryRequestBytes: bigint | number | null },
    copies: number
  ) => {
    const size = podResourcesFor(image, org, {
      cpuRequestMilli: row.cpuRequestMilli,
      memoryRequestBytes: row.memoryRequestBytes == null ? null : Number(row.memoryRequestBytes)
    });
    usage.cpuMilli += size.cpuMilli * copies;
    usage.memoryBytes += size.memoryBytes * copies;
    usage.pods += copies;
  };
  for (const d of project.deployments) {
    if (d.stopped || d.id === excludeDeploymentId) continue;
    add(d.image, d, d.replicas ?? 1);
  }
  for (const db of project.databases) {
    if (db.status === 'stopped') continue;
    add(MANAGED_DATABASE_IMAGE, db, Math.max(1, db.replicas ?? 1));
  }
  return usage;
}
