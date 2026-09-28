export const SNAPSHOT_SECRET_MASK = '••••••••';

export interface SnapshotCipher {
  readonly enabled: boolean;
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
}

export type SnapshotEnvVar = { key: string; value: string; secret?: boolean };

type StepLike = { envVars: SnapshotEnvVar[] };

const mapSecretValues = <T extends StepLike>(
  steps: T[],
  transform: (value: string) => string
): T[] =>
  steps.map((step) => ({
    ...step,
    envVars: (step.envVars ?? []).map((e) =>
      e.secret ? { ...e, value: transform(e.value ?? '') } : e
    )
  }));

const asSteps = <T extends StepLike>(raw: unknown): T[] => (Array.isArray(raw) ? (raw as T[]) : []);

export function encodeStepsSnapshot<T extends StepLike>(steps: T[], cipher: SnapshotCipher): T[] {
  return mapSecretValues(steps, (value) => (cipher.enabled ? cipher.encrypt(value) : ''));
}

export function decodeStepsSnapshot<T extends StepLike>(raw: unknown, cipher: SnapshotCipher): T[] {
  return mapSecretValues(asSteps<T>(raw), (value) => cipher.decrypt(value));
}

export function maskStepsSnapshot<T extends StepLike>(raw: unknown): T[] {
  return mapSecretValues(asSteps<T>(raw), () => SNAPSHOT_SECRET_MASK);
}
