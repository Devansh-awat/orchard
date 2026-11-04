import * as crypto from 'crypto';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_LABEL = 63;

/**
 * Compose allows volume names Kubernetes refuses, and the name ends up as both a
 * PVC and a pod volume. A valid name is kept as written. Anything else gets a
 * suffix hashed from the original, so a redeploy finds the same claim and
 * `db_data` never lands on the claim that belongs to `db-data`.
 */
export function composeVolumeName(name: string): string {
  if (DNS_LABEL.test(name) && name.length <= MAX_LABEL) return name;
  const suffix = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_LABEL - suffix.length - 1)
    .replace(/-+$/, '');
  return slug ? `${slug}-${suffix}` : `volume-${suffix}`;
}
