export type ObservedJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export function isObservedJobStatus(status?: string | null): status is ObservedJobStatus {
  return (
    status === 'pending' || status === 'running' || status === 'succeeded' || status === 'failed'
  );
}
