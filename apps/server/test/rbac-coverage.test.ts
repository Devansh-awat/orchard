import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadAll } from 'js-yaml';
import { BUILDER_ROLE_RULES } from '../src/docker/builder-rbac';
import { tailscaleRoleRules } from '../src/kubernetes/tailscale-rbac';
import { tenantSecretsRole } from '../src/kubernetes/tenant-rbac';

type Rule = { apiGroups?: string[]; resources?: string[]; verbs?: string[] };
type Doc = { kind?: string; metadata?: { name?: string; namespace?: string }; rules?: Rule[] };

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function rendered(): Doc[] {
  const out = execFileSync('helm', ['template', 'orchard', chart, '--namespace', 'orchard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return loadAll(out).filter((d): d is Doc => !!d && typeof d === 'object');
}

function rulesOf(docs: Doc[], kind: string, name: string): Rule[] {
  const doc = docs.find((d) => d.kind === kind && d.metadata?.name === name);
  assert.ok(doc, `${kind} ${name} rendered`);
  return doc.rules ?? [];
}

function grants(held: Rule[], group: string, resource: string, verb: string): boolean {
  return held.some(
    (r) =>
      (r.apiGroups ?? []).some((g) => g === '*' || g === group) &&
      (r.resources ?? []).some((x) => x === '*' || x === resource) &&
      (r.verbs ?? []).some((v) => v === '*' || v === verb)
  );
}

function assertCovered(minted: Rule[], held: Rule[], label: string) {
  for (const rule of minted) {
    for (const group of rule.apiGroups ?? ['']) {
      for (const resource of rule.resources ?? []) {
        for (const verb of rule.verbs ?? []) {
          assert.ok(
            grants(held, group, resource, verb),
            `${label}: server cannot grant ${verb} on ${group || 'core'}/${resource} without escalate`
          );
        }
      }
    }
  }
}

test(
  'every role the server mints at runtime fits inside what the chart grants it',
  { skip: !helmAvailable() },
  () => {
    const docs = rendered();
    const cluster = rulesOf(docs, 'ClusterRole', 'orchard-server');
    assert.ok(
      !cluster.some((r) => (r.verbs ?? []).includes('escalate')),
      'no escalate on the server'
    );

    const inBuilders = [...cluster, ...rulesOf(docs, 'Role', 'orchard-image-builder-secrets')];
    assertCovered(BUILDER_ROLE_RULES, inBuilders, 'image-builder-role');

    const tenantSecrets = rulesOf(docs, 'ClusterRole', 'orchard-tenant-secrets');
    const inTenant = [...cluster, ...tenantSecrets];
    assertCovered(tailscaleRoleRules('ts-state'), inTenant, 'tailscale role');
    assertCovered(
      tenantSecretsRole('tenant').rules ?? [],
      tenantSecrets,
      'tenant secrets fallback role'
    );
  }
);
