import { createHmac } from 'crypto';
import { Resolver } from 'dns/promises';

export const DOMAIN_PROOF_PREFIX = '_orchard-challenge';

export function domainProofToken(projectId: string, host: string): string {
  const secret = process.env.JWT_SECRET || '';
  return `orchard-domain=${createHmac('sha256', secret)
    .update(`${projectId}:${host.toLowerCase()}`)
    .digest('hex')
    .slice(0, 40)}`;
}

export function domainProofRecordName(host: string): string {
  const labels = host.split('.');
  const relative = labels.slice(0, -2).join('.');
  return relative ? `${DOMAIN_PROOF_PREFIX}.${relative}` : DOMAIN_PROOF_PREFIX;
}

export function parentDomains(host: string): string[] {
  const labels = host.split('.');
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'));
}

export async function lookupDomainProof(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  const records = await resolver.resolveTxt(`${DOMAIN_PROOF_PREFIX}.${host}`).catch(() => []);
  return records.map((chunks) => chunks.join('').trim());
}
