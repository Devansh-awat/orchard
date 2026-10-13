import { statusMeta, type StatusMeta } from '@orchard/graft-ui';
import type { SandboxStatus } from './types/sandbox';

export { previewStatus, statusMeta } from '@orchard/graft-ui';
export type { PreviewDeployStatus, StatusKind, StatusMeta } from '@orchard/graft-ui';

export interface SandboxStatusContext {
  applying?: boolean;
  applyError?: string | null;
  desiredState?: 'running' | 'stopped' | 'deleted';
}

const meta = statusMeta;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function sandboxStatus(status: SandboxStatus, ctx: SandboxStatusContext = {}): StatusMeta {
  if (status === 'deleting' || ctx.desiredState === 'deleted') {
    return meta('error', 'Deleting', true);
  }
  if (ctx.applyError && status !== 'running' && status !== 'stopped') {
    return meta('error', 'Apply failed');
  }
  if (ctx.applyError) return meta('warning', status === 'running' ? 'Running' : 'Stopped');
  if (ctx.applying) {
    if (ctx.desiredState === 'stopped' && status !== 'stopped')
      return meta('progress', 'Stopping', true);
    if (ctx.desiredState === 'running' && status !== 'running')
      return meta('progress', 'Starting', true);
    return meta('progress', 'Applying', true);
  }
  switch (status) {
    case 'running':
      return meta('success', 'Running');
    case 'creating':
    case 'starting':
    case 'stopping':
      return meta('progress', capitalize(status), true);
    case 'stopped':
      return meta('neutral', 'Stopped');
    case 'error':
      return meta('error', 'Error');
    default:
      return meta('neutral', capitalize(status));
  }
}
