import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';
import {
  cnpgOperatorNamespace,
  databasePlatformPolicy,
  tenantDenyPolicy
} from '../src/kubernetes/security-policies';

async function main() {
  const [namespace, mode = 'full'] = process.argv.slice(2);
  if (!namespace) throw new Error('usage: netpol-e2e-policies <namespace> [full|deny-only]');

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const kube = Object.create(KubernetesService.prototype) as KubernetesService;
  (kube as unknown as { kc: k8s.KubeConfig }).kc = kc;

  const withoutCilium = !(await kube.isCiliumAvailable());
  const items: object[] = [
    tenantDenyPolicy(namespace, { clusterExcepts: await kube.clusterExceptCidrs() })
  ];
  if (mode === 'full') {
    items.push(
      databasePlatformPolicy(namespace, {
        storage: null,
        apiserver: withoutCilium ? await kube.apiserverEndpoints() : null,
        operatorNamespace: withoutCilium ? cnpgOperatorNamespace() : null
      })
    );
  }
  process.stdout.write(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
