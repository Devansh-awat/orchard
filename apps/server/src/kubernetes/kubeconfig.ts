import * as k8s from '@kubernetes/client-node';

/**
 * KUBECONFIG_PATH historically accepts either a path or the kubeconfig itself
 * base64 encoded, and the production HelmRelease uses the latter. Anything
 * loading it as a plain path fails with ENAMETOOLONG, so every caller has to
 * go through here.
 */
export function loadKubeConfigFromPathOrBase64(kc: k8s.KubeConfig, value: string): void {
  let raw = value.trim();
  while ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }

  if (!raw.includes('/') && !raw.includes('\\') && raw.length > 100) {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    if (decoded.includes('apiVersion:') || decoded.includes('kind: Config')) {
      kc.loadFromString(decoded);
      return;
    }
  }

  kc.loadFromFile(raw);
}
