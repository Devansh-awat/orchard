export function engineDisabled(): boolean {
  return process.env.ENGINE_DISABLED === 'true' || process.env.MIRROR_DISABLED === 'true';
}
