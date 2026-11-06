import { completeChain, pemCertificates } from './tls-secret-sync';

export type PublicDbTlsIssuer = { name: string; kind: string };

export function publicDbTlsNames(clusterName: string) {
  return {
    certificate: `${clusterName}--tls`,
    secret: `${clusterName}--tls`,
    ca: `${clusterName}--tls-ca`
  };
}

export function publicDbCertificate(options: {
  namespace: string;
  clusterName: string;
  hostnames: string[];
  issuer: PublicDbTlsIssuer;
}) {
  const names = publicDbTlsNames(options.clusterName);
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: names.certificate,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'orchard',
        'cnpg.io/cluster': options.clusterName
      }
    },
    spec: {
      secretName: names.secret,
      issuerRef: { name: options.issuer.name, kind: options.issuer.kind },
      commonName: options.hostnames[0],
      dnsNames: options.hostnames,
      privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
      duration: '2160h',
      renewBefore: '360h'
    }
  };
}

export function publicDbClusterCertificates(clusterName: string) {
  const names = publicDbTlsNames(clusterName);
  return {
    serverTLSSecret: names.secret,
    serverCASecret: names.ca,
    serverAltDNSNames: null
  };
}

export function clusterUsesPublicDbTls(
  cluster: { spec?: { certificates?: { serverTLSSecret?: string; serverCASecret?: string } } },
  clusterName: string
): boolean {
  const names = publicDbTlsNames(clusterName);
  const certs = cluster.spec?.certificates;
  return certs?.serverTLSSecret === names.secret && certs?.serverCASecret === names.ca;
}

export function caBundleForIssuedSecret(
  data: { 'ca.crt'?: string; 'tls.crt'?: string },
  roots?: readonly string[]
): string | null {
  if (data['ca.crt']) return data['ca.crt'];
  if (!data['tls.crt']) return null;
  const chain = pemCertificates(Buffer.from(data['tls.crt'], 'base64').toString('utf8'));
  const issuers = chain.slice(1);
  if (issuers.length === 0) return null;
  const bundle = roots ? completeChain(issuers, roots) : completeChain(issuers);
  return Buffer.from(`${bundle.join('\n')}\n`, 'utf8').toString('base64');
}
