export interface EnvironmentEnvChange {
  projectId?: string | null;
  environmentId?: string | null;
}

type Listener = (change: EnvironmentEnvChange) => void;

const listeners = new Set<Listener>();

export function onEnvironmentEnvChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function signalEnvironmentEnvChanged(change: EnvironmentEnvChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      continue;
    }
  }
}
