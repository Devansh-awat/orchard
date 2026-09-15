import * as k8s from '@kubernetes/client-node';

export const TLS_SOURCE_RV_LABEL = 'orchard.my/tls-source-rv';
const LEGACY_TLS_SOURCE_RV_LABEL = 'orchard.dev/tls-source-rv';

/**
 * Copy a TLS Secret from one namespace into another.
 *
 * A wildcard certificate is issued once, into one namespace, but every tenant
 * Ingress that reuses it references the Secret by name in its *own* namespace.
 * Something has to put it there. Production runs emberstack/reflector for this;
 * doing it here means a self-hosted install needs no extra component, and the
 * mechanics were already written for CNPG's public TLS.
 *
 * Returns true when the target was written, false when it was already current.
 * The source resourceVersion is stamped on the copy so a renewal is detected
 * without comparing certificate bodies.
 */
export async function syncTlsSecret(
  coreApi: k8s.CoreV1Api,
  source: { namespace: string; name: string },
  target: { namespace: string; name: string }
): Promise<boolean> {
  const { body: src } = await coreApi.readNamespacedSecret(source.name, source.namespace);
  if (!src.data?.['tls.crt'] || !src.data?.['tls.key']) {
    throw new Error(
      `Source secret ${source.namespace}/${source.name} is missing tls.crt / tls.key`
    );
  }

  // cert-manager concatenates the leaf and its issuing intermediates into
  // tls.crt and usually leaves ca.crt empty for public ACME issuers. Consumers
  // that require a ca.crt (CNPG) need the intermediates split back out.
  let caCrtB64 = src.data['ca.crt'];
  if (!caCrtB64) {
    const fullChainPem = Buffer.from(src.data['tls.crt'], 'base64').toString('utf-8');
    const certs =
      fullChainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (certs.length >= 2) {
      caCrtB64 = Buffer.from(`${certs.slice(1).join('\n')}\n`, 'utf-8').toString('base64');
    }
  }

  const srcRv = src.metadata?.resourceVersion || '';
  const body: k8s.V1Secret = {
    metadata: {
      name: target.name,
      namespace: target.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'orchard',
        [TLS_SOURCE_RV_LABEL]: srcRv
      }
    },
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': src.data['tls.crt'],
      'tls.key': src.data['tls.key'],
      ...(caCrtB64 ? { 'ca.crt': caCrtB64 } : {})
    }
  };

  try {
    const { body: existing } = await coreApi.readNamespacedSecret(target.name, target.namespace);
    const existingRv =
      existing.metadata?.labels?.[TLS_SOURCE_RV_LABEL] ??
      existing.metadata?.labels?.[LEGACY_TLS_SOURCE_RV_LABEL];
    if (existingRv === srcRv) return false;
    await coreApi.replaceNamespacedSecret(target.name, target.namespace, body);
    return true;
  } catch (e: any) {
    if (e.response?.statusCode === 404) {
      await coreApi.createNamespacedSecret(target.namespace, body);
      return true;
    }
    throw e;
  }
}
