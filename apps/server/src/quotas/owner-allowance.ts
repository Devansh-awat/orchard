export function ownerLeftAllowance(
  org: {
    defaultMemberCpuMilli: number | null;
    defaultMemberMemoryBytes: bigint | number | null;
  } | null
): { cpuMilli: number | null; memoryBytes: number | null } {
  if (!org) return { cpuMilli: 0, memoryBytes: 0 };
  return {
    cpuMilli: org.defaultMemberCpuMilli,
    memoryBytes: org.defaultMemberMemoryBytes === null ? null : Number(org.defaultMemberMemoryBytes)
  };
}
