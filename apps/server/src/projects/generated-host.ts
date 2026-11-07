import { createHash, createHmac } from 'node:crypto';
import { formatSlug } from './projects.utils';

export type HostnameStyle = 'opaque' | 'readable';

export function hostnameStyle(env: NodeJS.ProcessEnv = process.env): HostnameStyle {
  return (env.HOSTNAME_STYLE || '').trim().toLowerCase() === 'readable' ? 'readable' : 'opaque';
}

function truncate(value: string, max: number): string {
  return value.slice(0, max).replace(/-+$/, '');
}

export interface GeneratedHostInput {
  deploymentId: string;
  deploymentName: string;
  projectSlug: string;
  attempt: number;
}

export function opaqueDatabaseLabel(
  namespace: string,
  clusterName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const digest = createHmac('sha256', env.JWT_SECRET || 'orchard-generated-host')
    .update(`database-host\0${namespace}\0${clusterName}`)
    .digest('hex');
  return `db-${digest.slice(0, 20)}`;
}

export function generatedHostLabel(
  input: GeneratedHostInput,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (hostnameStyle(env) === 'readable') {
    const hash = createHash('sha256')
      .update(`${input.deploymentId}:${input.attempt}`)
      .digest('hex')
      .slice(0, 6);
    return [
      truncate(formatSlug(input.deploymentName), 40),
      truncate(formatSlug(input.projectSlug), 10),
      hash
    ]
      .filter(Boolean)
      .join('-');
  }
  const digest = createHmac('sha256', env.JWT_SECRET || 'orchard-generated-host')
    .update(`generated-host\0${input.deploymentId}\0${input.attempt}`)
    .digest('hex');
  return `${digest.slice(0, 10)}-${digest.slice(10, 16)}`;
}
