import { Injectable, Logger, BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  KubernetesService,
  CreateIngressOptions,
  CreateAdditionalServiceOptions,
  DeleteDeploymentServiceOptions,
  UpdateServiceExposureOptions,
  UpdateServicePortsOptions,
  ALLOWED_INGRESS_ANNOTATION_KEYS,
} from './kubernetes.service';
import { mapServicePorts, ensureUniqueServicePorts, sanitizePortEntries } from './port-utils';
import { truncateK8sName } from '../projects/projects.utils';

/**
 * All Kubernetes network/edge resources: Services, Ingress (Cilium),
 * basic-auth (CiliumEnvoyConfig), public exposure (Cilium LB IPAM
 * LoadBalancer + NetworkPolicies) for both CNPG clusters and raw
 * deployment ports, and endpoint listing.
 */
@Injectable()
export class K8sNetworkService implements OnModuleInit {
  private readonly logger = new Logger(K8sNetworkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
  ) {}

  onModuleInit() {
    setTimeout(() => {
      void this.reconcileProtectionProxies();
    }, 10_000);
    setInterval(() => {
      void this.reconcileProtectionProxies();
    }, 10 * 60 * 1000).unref();
  }

  async reconcileProtectionProxies(): Promise<void> {
    if (!this.kc) return;

    let protectedIngresses: { namespace: string; name: string }[];
    try {
      protectedIngresses = await this.prisma.ingress.findMany({
        where: { protectionMode: { not: 'none' } },
        select: { namespace: true, name: true },
        distinct: ['namespace', 'name'],
      });
    } catch (error) {
      this.logger.warn(`Failed to list protected ingresses for reconcile: ${error.message}`);
      return;
    }

    for (const ingress of protectedIngresses) {
      try {
        await this.enableProtectionProxy(ingress.namespace, ingress.name);
      } catch (error) {
        this.logger.warn(
          `Failed to reconcile protection proxy for ${ingress.namespace}/${ingress.name}: ${error.message}`,
        );
      }
    }

    if (protectedIngresses.length > 0) {
      this.logger.log(`Reconciled protection proxies for ${protectedIngresses.length} ingress(es)`);
    }

    try {
      await this.restoreOrphanedProtectionBackends(
        new Set(protectedIngresses.map((i) => `${i.namespace}/${i.name}`)),
      );
    } catch (error) {
      this.logger.warn(`Failed to restore orphaned protection backends: ${error.message}`);
    }
  }

  private async restoreOrphanedProtectionBackends(protectedKeys: Set<string>): Promise<void> {
    const proxyServiceName = 'orchard-protection-proxy';
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const allIngresses = await networkingApi.listIngressForAllNamespaces(
      undefined,
      undefined,
      undefined,
      'leaf.dev/managed=true',
    );

    for (const ingress of allIngresses.body.items) {
      const namespace = ingress.metadata?.namespace;
      const name = ingress.metadata?.name;
      if (!namespace || !name || protectedKeys.has(`${namespace}/${name}`)) continue;

      const rules = ingress.spec?.rules || [];
      const proxied = rules.some((rule) =>
        (rule.http?.paths || []).some((p) => p.backend?.service?.name === proxyServiceName),
      );
      if (!proxied) continue;

      try {
        await coreApi.readNamespacedService(proxyServiceName, namespace);
        continue;
      } catch (error) {
        if (error.response?.statusCode !== 404) continue;
      }

      const rows = await this.prisma.ingress.findMany({
        where: { namespace, name },
        include: { service: { include: { ports: true } } },
      });
      if (rows.length === 0 || rows.some((r) => r.protectionMode !== 'none')) continue;

      const backendByPath = new Map(
        rows
          .filter((r) => r.service)
          .map((r) => [
            r.path || '/',
            {
              name: r.service!.name,
              port: Number(r.service!.ports?.[0]?.port ?? r.service!.port),
            },
          ]),
      );

      let restored = false;
      for (const rule of rules) {
        for (const p of rule.http?.paths || []) {
          if (p.backend?.service?.name !== proxyServiceName) continue;
          const original = backendByPath.get(p.path || '/') ?? backendByPath.values().next().value;
          if (!original || !Number.isInteger(original.port) || original.port <= 0) continue;
          p.backend = { service: { name: original.name, port: { number: original.port } } };
          restored = true;
        }
      }

      if (!restored) continue;

      try {
        await networkingApi.replaceNamespacedIngress(name, namespace, ingress);
        this.logger.log(`Restored orphaned protection backend on ${namespace}/${name}`);
      } catch (error) {
        this.logger.warn(`Failed to restore ${namespace}/${name}: ${error.message}`);
      }
    }
  }

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  private getDefaultNodeIp(coreApi: k8s.CoreV1Api) {
    return this.kubernetes.getDefaultNodeIp(coreApi);
  }

  async listEndpoints(namespace?: string) {
    this.ensureKubeConfig();
    
    const cleanNamespace = namespace ? String(namespace).trim() : undefined;
    
    console.log('[API] Fetching endpoints', cleanNamespace ? `from namespace: ${cleanNamespace}` : 'from all namespaces');
    
    try {
      const api = this.kc.makeApiClient(k8s.CoreV1Api);
      
      let endpointList;
      if (cleanNamespace) {
        endpointList = await api.listNamespacedEndpoints(cleanNamespace);
      } else {
        endpointList = await api.listEndpointsForAllNamespaces();
      }
      
      const endpoints = endpointList.body.items.map(endpoint => ({
        name: endpoint.metadata.name,
        namespace: endpoint.metadata.namespace,
        subsets: endpoint.subsets?.map(subset => ({
          addresses: subset.addresses?.map(addr => ({
            ip: addr.ip,
            hostname: addr.hostname,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef ? {
              kind: addr.targetRef.kind,
              name: addr.targetRef.name,
              namespace: addr.targetRef.namespace
            } : undefined
          })),
          notReadyAddresses: subset.notReadyAddresses?.map(addr => ({
            ip: addr.ip,
            hostname: addr.hostname,
            nodeName: addr.nodeName,
            targetRef: addr.targetRef ? {
              kind: addr.targetRef.kind,
              name: addr.targetRef.name,
              namespace: addr.targetRef.namespace
            } : undefined
          })),
          ports: subset.ports?.map(port => ({
            name: port.name,
            port: port.port,
            protocol: port.protocol
          }))
        })),
        labels: endpoint.metadata.labels,
        annotations: endpoint.metadata.annotations
      }));

      return {
        namespace: cleanNamespace || 'all',
        endpointCount: endpoints.length,
        endpoints
      };
    } catch (error) {
      console.error('Error fetching endpoints:', error);
      
      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to fetch endpoints from Kubernetes',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }
      
      throw new BadRequestException({
        error: 'Failed to fetch endpoints',
        message: error.message
      });
    }
  }


  async createBasicAuthSecret(namespace: string, name: string, username: string, password: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Secret name is required');
    }

    if (!username || !password) {
      throw new BadRequestException('Username and password are required');
    }

    const sha1Hash = crypto.createHash('sha1').update(password).digest('base64');
    const authString = `${username}:{SHA}${sha1Hash}`;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const secretBody: k8s.V1Secret = {
      metadata: {
        name: cleanName,
        namespace: cleanNamespace,
        labels: {
          'leaf.dev/managed': 'true',
          'leaf.dev/type': 'basic-auth'
        }
      },
      type: 'Opaque',
      stringData: {
        users: authString
      }
    };

    try {
      await coreApi.createNamespacedSecret(cleanNamespace, secretBody);
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedSecret(cleanName, cleanNamespace, secretBody);
      } else {
        throw new BadRequestException({
          error: 'Failed to create basic auth secret',
          message: error.response?.body?.message || error.message,
          details: error.response?.body
        });
      }
    }
  }

  async deleteBasicAuthSecret(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedSecret(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete basic auth secret ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async createBasicAuthMiddleware(
    namespace: string,
    name: string,
    username: string,
    password: string,
    serviceName: string,
    servicePort: number,
  ): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const sha1Hash = crypto.createHash('sha1').update(password).digest('base64');
    const htpasswd = `${username}:{SHA}${sha1Hash}`;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const envoyConfigBody = {
      apiVersion: 'cilium.io/v2',
      kind: 'CiliumEnvoyConfig',
      metadata: {
        name: `${cleanName}-auth`,
        namespace: cleanNamespace,
        labels: {
          'orchard.my/managed': 'true',
          'orchard.my/type': 'basic-auth',
        },
      },
      spec: {
        services: [
          { name: serviceName, namespace: cleanNamespace, ports: [servicePort] },
        ],
        resources: [
          {
            '@type': 'type.googleapis.com/envoy.config.listener.v3.Listener',
            name: `${cleanName}-auth-listener`,
            filter_chains: [
              {
                filters: [
                  {
                    name: 'envoy.filters.network.http_connection_manager',
                    typed_config: {
                      '@type': 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                      stat_prefix: `${cleanName}-auth`,
                      route_config: {
                        name: `${cleanName}-auth-route`,
                        virtual_hosts: [{
                          name: 'default',
                          domains: ['*'],
                          routes: [{
                            match: { prefix: '/' },
                            route: { cluster: `${cleanNamespace}:${serviceName}:${servicePort}` },
                          }],
                        }],
                      },
                      http_filters: [
                        {
                          name: 'envoy.filters.http.basic_auth',
                          typed_config: {
                            '@type': 'type.googleapis.com/envoy.extensions.filters.http.basic_auth.v3.BasicAuth',
                            users: { inline_string: htpasswd },
                          },
                        },
                        {
                          name: 'envoy.filters.http.router',
                          typed_config: {
                            '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    try {
      await customObjectsApi.createNamespacedCustomObject(
        'cilium.io',
        'v2',
        cleanNamespace,
        'ciliumenvoyconfigs',
        envoyConfigBody
      );
    } catch (error) {
      if (error.response?.statusCode === 409) {
        try {
          await customObjectsApi.replaceNamespacedCustomObject(
            'cilium.io',
            'v2',
            cleanNamespace,
            'ciliumenvoyconfigs',
            `${cleanName}-auth`,
            envoyConfigBody
          );
        } catch (replaceError) {
          console.error(`Failed to update basic auth CiliumEnvoyConfig: ${replaceError.message}`);
        }
      } else {
        console.error(`Failed to create basic auth CiliumEnvoyConfig: ${error.message}`);
      }
    }
  }

  async deleteBasicAuthMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    try {
      await customObjectsApi.deleteNamespacedCustomObject(
        'cilium.io',
        'v2',
        cleanNamespace,
        'ciliumenvoyconfigs',
        `${cleanName}-auth`
      );
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete basic auth CiliumEnvoyConfig ${cleanName}-auth in ${cleanNamespace}:`, error);
      }
    }
  }

  async deleteHttpsRedirectMiddleware(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    try {
      await customObjectsApi.deleteNamespacedCustomObject(
        'cilium.io',
        'v2',
        cleanNamespace,
        'ciliumenvoyconfigs',
        `${cleanName}-https-redirect`,
      );
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete HTTPS redirect CiliumEnvoyConfig ${cleanName}-https-redirect in ${cleanNamespace}:`, error);
      }
    }
  }


  async enableProtectionProxy(namespace: string, ingressName: string): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(ingressName || '').trim();
    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const authServerNamespace = process.env.ORCHARD_NAMESPACE || 'orchard';
    const authServerPort = parseInt(process.env.ORCHARD_SERVER_PORT || '3001', 10);
    const proxyServiceName = 'orchard-protection-proxy';

    const serverService = await coreApi.readNamespacedService('server', authServerNamespace);
    const clusterIP = serverService.body.spec?.clusterIP;
    if (!clusterIP || clusterIP === 'None') {
      this.logger.error('No stable ClusterIP on server service for protection proxy');
      return;
    }
    const addresses = [clusterIP];

    const svcBody: k8s.V1Service = {
      metadata: {
        name: proxyServiceName,
        namespace: cleanNamespace,
        labels: { 'orchard.my/managed': 'true', 'orchard.my/type': 'protection-proxy' },
      },
      spec: {
        clusterIP: 'None',
        ports: [{ port: authServerPort, targetPort: authServerPort, protocol: 'TCP' } as k8s.V1ServicePort],
      },
    };

    try {
      await coreApi.createNamespacedService(cleanNamespace, svcBody);
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await coreApi.replaceNamespacedService(proxyServiceName, cleanNamespace, svcBody);
      } else {
        console.error(`Failed to create protection proxy service: ${error.message}`);
        return;
      }
    }

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const endpointSlice = {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: {
        name: `${proxyServiceName}-1`,
        namespace: cleanNamespace,
        labels: { 'kubernetes.io/service-name': proxyServiceName, 'orchard.my/managed': 'true' },
      },
      addressType: 'IPv4',
      ports: [{ port: authServerPort, protocol: 'TCP' }],
      endpoints: [{ addresses, conditions: { ready: true, serving: true } }],
    };

    try {
      await customApi.createNamespacedCustomObject('discovery.k8s.io', 'v1', cleanNamespace, 'endpointslices', endpointSlice);
    } catch (error) {
      if (error.response?.statusCode === 409) {
        await customApi.replaceNamespacedCustomObject('discovery.k8s.io', 'v1', cleanNamespace, 'endpointslices', `${proxyServiceName}-1`, endpointSlice);
      } else {
        console.error(`Failed to create protection proxy endpoint slice: ${error.message}`);
      }
    }

    await this.ensureOrchardIngressAllowed(cleanNamespace);

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const ingress = await networkingApi.readNamespacedIngress(cleanName, cleanNamespace);
      const rules = ingress.body.spec?.rules || [];
      for (const rule of rules) {
        for (const path of rule.http?.paths || []) {
          path.backend = {
            service: { name: proxyServiceName, port: { number: authServerPort } },
          };
        }
      }
      await networkingApi.replaceNamespacedIngress(cleanName, cleanNamespace, ingress.body);
    } catch (error) {
      console.error(`Failed to update ingress backend for protection: ${error.message}`);
    }
  }

  async disableProtectionProxy(
    namespace: string,
    ingressName: string,
    originalServiceName: string,
    originalServicePort: number,
  ): Promise<void> {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(ingressName || '').trim();
    if (!cleanNamespace || !cleanName) return;

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const ingress = await networkingApi.readNamespacedIngress(cleanName, cleanNamespace);
      const rules = ingress.body.spec?.rules || [];
      for (const rule of rules) {
        for (const path of rule.http?.paths || []) {
          path.backend = {
            service: { name: originalServiceName, port: { number: originalServicePort } },
          };
        }
      }
      await networkingApi.replaceNamespacedIngress(cleanName, cleanNamespace, ingress.body);
    } catch (error) {
      console.error(`Failed to restore ingress backend: ${error.message}`);
    }

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const proxyServiceName = 'orchard-protection-proxy';
    try {
      await coreApi.deleteNamespacedService(proxyServiceName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete protection proxy service: ${error.message}`);
      }
    }

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject('discovery.k8s.io', 'v1', cleanNamespace, 'endpointslices', `${proxyServiceName}-1`);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete protection proxy endpoint slice: ${error.message}`);
      }
    }
  }

  async cleanupProtectionProxy(namespace: string): Promise<void> {
    this.ensureKubeConfig();
    const cleanNamespace = String(namespace || '').trim();
    if (!cleanNamespace) return;

    const proxyServiceName = 'orchard-protection-proxy';
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      await coreApi.deleteNamespacedService(proxyServiceName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete protection proxy service: ${error.message}`);
      }
    }

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject('discovery.k8s.io', 'v1', cleanNamespace, 'endpointslices', `${proxyServiceName}-1`);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete protection proxy endpoint slice: ${error.message}`);
      }
    }
  }

  private async ensureOrchardIngressAllowed(namespace: string): Promise<void> {
    const orchardSelector = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'orchard' } } };

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const np = await networkingApi.readNamespacedNetworkPolicy('default-deny-all', namespace);
      const from = np.body.spec?.ingress?.[0]?.from || [];
      const hasOrchard = from.some((f: any) => f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'orchard');
      if (!hasOrchard) {
        from.push(orchardSelector);
        await networkingApi.replaceNamespacedNetworkPolicy('default-deny-all', namespace, np.body);
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404) this.logger.warn(`Failed to patch NetworkPolicy: ${e.message}`);
    }

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const cnp: any = await customApi.getNamespacedCustomObject('cilium.io', 'v2', namespace, 'ciliumnetworkpolicies', 'allow-cilium-ingress');
      const ingress = cnp.body?.spec?.ingress || [];
      const hasOrchard = ingress.some((rule: any) =>
        rule.fromEndpoints?.some((ep: any) => ep.matchLabels?.['kubernetes.io/metadata.name'] === 'orchard'),
      );
      const hasHaproxy = ingress.some((rule: any) =>
        rule.fromEndpoints?.some((ep: any) =>
          ep.matchLabels?.['kubernetes.io/metadata.name'] === 'network' &&
          ep.matchLabels?.['app.kubernetes.io/name'] === 'kubernetes-ingress',
        ),
      );
      if (!hasOrchard || !hasHaproxy) {
        if (!hasOrchard) {
          ingress.push({ fromEndpoints: [{ matchLabels: { 'kubernetes.io/metadata.name': 'orchard' } }] });
        }
        if (!hasHaproxy) {
          ingress.push({
            fromEndpoints: [
              {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'network',
                  'app.kubernetes.io/name': 'kubernetes-ingress',
                },
              },
            ],
          });
        }
        cnp.body.spec.ingress = ingress;
        await customApi.replaceNamespacedCustomObject('cilium.io', 'v2', namespace, 'ciliumnetworkpolicies', 'allow-cilium-ingress', cnp.body);
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404) this.logger.warn(`Failed to patch CiliumNetworkPolicy: ${e.message}`);
    }
  }

  async createIngress(options: CreateIngressOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    const host = String(options.host || '').trim().toLowerCase();
    const ingressClassName =
      String(options.ingressClassName || '').trim() || undefined;

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!name) {
      throw new BadRequestException('Ingress name is required');
    }

    if (!host) {
      throw new BadRequestException('Host is required');
    }

    const pathBackends = Array.isArray(options.paths) && options.paths.length > 0
      ? options.paths
      : [{
          path: String(options.path || '/').trim() || '/',
          pathType: String(options.pathType || 'Prefix').trim() || 'Prefix',
          serviceName: String(options.serviceName || '').trim(),
          servicePort: Number(options.servicePort)
        }];

    if (!pathBackends[0].serviceName || !Number.isInteger(pathBackends[0].servicePort) || pathBackends[0].servicePort <= 0) {
      throw new BadRequestException('Service name and port are required');
    }

    for (const pb of pathBackends) {
      const svcName = String(pb.serviceName || '').trim();
      const svcPort = Number(pb.servicePort);
      if (!svcName || !Number.isInteger(svcPort) || svcPort <= 0) {
        throw new BadRequestException('Each path must have a valid service name and port');
      }
    }

    const annotations: Record<string, string> = {};

    if (options.annotations) {
      for (const [key, value] of Object.entries(options.annotations)) {
        if (value === undefined || value === null) {
          continue;
        }
        const k = String(key);
        if (!ALLOWED_INGRESS_ANNOTATION_KEYS.has(k)) continue;
        annotations[k] = String(value);
      }
    }

    const hasTls = options.tlsSecretName && options.tlsSecretName.trim().length > 0;

    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
      const targetService = pathBackends[0];
      try {
        await this.createBasicAuthSecret(
          namespace,
          basicAuthSecretName,
          options.basicAuth.username,
          options.basicAuth.password
        );

        await this.createBasicAuthMiddleware(
          namespace,
          name,
          options.basicAuth.username,
          options.basicAuth.password,
          String(targetService.serviceName).trim(),
          Number(targetService.servicePort),
        );
        annotations['orchard.my/basic-auth'] = 'true';
      } catch (error) {
        console.error('[K8s] Failed to create basic auth:', error);
      }
    }

    try {
      await this.deleteHttpsRedirectMiddleware(namespace, name);
    } catch (error) {
      console.error('[K8s] Failed to remove stale HTTPS redirect middleware:', error);
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const requestedTlsHosts = options.tlsHosts && options.tlsHosts.length > 0 ? options.tlsHosts : [host];
    const tlsHosts = hasTls ? requestedTlsHosts : [];

    const httpPaths = pathBackends.map((pb) => {
      const path = String(pb.path || '/').trim() || '/';
      const pathType = String(pb.pathType || 'Prefix').trim() || 'Prefix';
      return {
        path,
        pathType,
        backend: {
          service: {
            name: String(pb.serviceName).trim(),
            port: { number: Number(pb.servicePort) }
          }
        }
      };
    }).sort((a, b) => b.path.length - a.path.length);

    const ingressBody: k8s.V1Ingress = {
      metadata: {
        name,
        labels: {
          'leaf.dev/managed': 'true'
        },
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      },
      spec: {
        ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: httpPaths
            }
          }
        ]
      }
    };

    if (hasTls) {
      ingressBody.spec.tls = [
        {
          hosts: tlsHosts,
          secretName: options.tlsSecretName.trim()
        }
      ];
    }

    try {
      const response = await networkingApi.createNamespacedIngress(
        namespace,
        ingressBody
      );
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 409) {
        throw new BadRequestException({
          error: 'Ingress already exists',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to create ingress',
        message: error.message
      });
    }
  }

  async updateIngress(options: CreateIngressOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    const host = String(options.host || '').trim().toLowerCase();
    const ingressClassName =
      String(options.ingressClassName || '').trim() || undefined;

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!name) {
      throw new BadRequestException('Ingress name is required');
    }

    if (!host) {
      throw new BadRequestException('Host is required');
    }

    const pathBackends = Array.isArray(options.paths) && options.paths.length > 0
      ? options.paths
      : [{
          path: String(options.path || '/').trim() || '/',
          pathType: String(options.pathType || 'Prefix').trim() || 'Prefix',
          serviceName: String(options.serviceName || '').trim(),
          servicePort: Number(options.servicePort)
        }];

    if (!pathBackends[0].serviceName || !Number.isInteger(pathBackends[0].servicePort) || pathBackends[0].servicePort <= 0) {
      throw new BadRequestException('Service name and port are required');
    }

    for (const pb of pathBackends) {
      const svcName = String(pb.serviceName || '').trim();
      const svcPort = Number(pb.servicePort);
      if (!svcName || !Number.isInteger(svcPort) || svcPort <= 0) {
        throw new BadRequestException('Each path must have a valid service name and port');
      }
    }

    const annotations: Record<string, string> = {};

    if (options.annotations) {
      for (const [key, value] of Object.entries(options.annotations)) {
        if (value === undefined || value === null) {
          continue;
        }
        const k = String(key);
        if (!ALLOWED_INGRESS_ANNOTATION_KEYS.has(k)) continue;
        annotations[k] = String(value);
      }
    }

    const hasTls = options.tlsSecretName && options.tlsSecretName.trim().length > 0;

    if (options.basicAuth?.enabled && options.basicAuth.username && options.basicAuth.password) {
      const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
      const targetService = pathBackends[0];
      try {
        await this.createBasicAuthSecret(
          namespace,
          basicAuthSecretName,
          options.basicAuth.username,
          options.basicAuth.password
        );

        await this.createBasicAuthMiddleware(
          namespace,
          name,
          options.basicAuth.username,
          options.basicAuth.password,
          String(targetService.serviceName).trim(),
          Number(targetService.servicePort),
        );
        annotations['orchard.my/basic-auth'] = 'true';
      } catch (error) {
        console.error('[K8s] Failed to create basic auth:', error);
      }
    } else if (options.basicAuth?.enabled === false) {
      try {
        const basicAuthSecretName = options.basicAuth.secretName || `${name}-basic-auth`;
        await this.deleteBasicAuthSecret(namespace, basicAuthSecretName);
        await this.deleteBasicAuthMiddleware(namespace, name);
      } catch (error) {
        console.error('[K8s] Failed to remove basic auth:', error);
      }
    }

    try {
      await this.deleteHttpsRedirectMiddleware(namespace, name);
    } catch (error) {
      console.error('[K8s] Failed to remove HTTPS redirect middleware:', error);
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const requestedTlsHosts = options.tlsHosts && options.tlsHosts.length > 0 ? options.tlsHosts : [host];
    const tlsHosts = hasTls ? requestedTlsHosts : [];

    const httpPaths = pathBackends.map((pb) => {
      const path = String(pb.path || '/').trim() || '/';
      const pathType = String(pb.pathType || 'Prefix').trim() || 'Prefix';
      return {
        path,
        pathType,
        backend: {
          service: {
            name: String(pb.serviceName).trim(),
            port: { number: Number(pb.servicePort) }
          }
        }
      };
    }).sort((a, b) => b.path.length - a.path.length);

    const ingressBody: k8s.V1Ingress = {
      metadata: {
        name,
        labels: {
          'leaf.dev/managed': 'true'
        },
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined
      },
      spec: {
        ingressClassName,
        rules: [
          {
            host,
            http: {
              paths: httpPaths
            }
          }
        ]
      }
    };

    if (hasTls) {
      ingressBody.spec.tls = [
        {
          hosts: tlsHosts,
          secretName: options.tlsSecretName.trim()
        }
      ];
    } else {
      ingressBody.spec.tls = [];
    }

    try {
      const response = await networkingApi.replaceNamespacedIngress(
        name,
        namespace,
        ingressBody
      );
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Ingress not found',
          message: `Ingress ${name} not found in namespace ${namespace}`,
          details: error.response.body
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body
        });
      }

      throw new BadRequestException({
        error: 'Failed to update ingress',
        message: error.message
      });
    }
  }

  async patchIngressPathPort(
    namespace: string,
    ingressName: string,
    path: string,
    newPort: number,
  ) {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    const ingress = await networkingApi.readNamespacedIngress(ingressName, namespace);
    const paths = ingress.body.spec?.rules?.[0]?.http?.paths;
    if (!paths) return;

    const pathIndex = paths.findIndex((p) => p.path === path);
    if (pathIndex === -1) return;

    await networkingApi.patchNamespacedIngress(
      ingressName,
      namespace,
      [{ op: 'replace', path: `/spec/rules/0/http/paths/${pathIndex}/backend/service/port/number`, value: newPort }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } },
    );
  }

  async readIngress(namespace: string, name: string) {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    try {
      const response = await networkingApi.readNamespacedIngress(name, namespace);
      return response.body;
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async deleteIngress(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!cleanName) {
      throw new BadRequestException('Ingress name is required');
    }

    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);

    try {
      await networkingApi.deleteNamespacedIngress(cleanName, cleanNamespace);

      await this.deleteBasicAuthSecret(cleanNamespace, `${cleanName}-basic-auth`);
      await this.deleteBasicAuthMiddleware(cleanNamespace, cleanName);
      await this.cleanupProtectionProxy(cleanNamespace);

      return {
        success: true,
        namespace: cleanNamespace,
        name: cleanName,
        deleted: true,
      };
    } catch (error) {
      if (error.response?.statusCode === 404) {
        return {
          success: true,
          namespace: cleanNamespace,
          name: cleanName,
          deleted: false,
        };
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete ingress',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete ingress',
        message: error.message,
      });
    }
  }

  async deleteService(namespace: string, name: string) {
    this.ensureKubeConfig();

    const cleanNamespace = String(namespace || '').trim();
    const cleanName = String(name || '').trim();

    if (!cleanNamespace || !cleanName) return;

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    try {
      await coreApi.deleteNamespacedService(cleanName, cleanNamespace);
    } catch (error) {
      if (error.response?.statusCode !== 404) {
        console.error(`Failed to delete service ${cleanName} in ${cleanNamespace}:`, error);
      }
    }
  }

  async updateServicePorts(options: UpdateServicePortsOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const sanitizedPorts = sanitizePortEntries(
      Array.isArray(options.ports) ? options.ports : []
    );
    const normalizedPorts = ensureUniqueServicePorts(sanitizedPorts);

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const existingDeployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
      const containers = existingDeployment.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'No containers found',
          message: `Deployment "${deploymentName}" has no containers`,
        });
      }

      const containerName = containers[0].name;
      const existingContainer = containers[0];

      const updatedContainer = {
        ...existingContainer,
        ports: normalizedPorts.map((port) => ({
          name: port.name,
          containerPort: port.containerPort,
          protocol: port.protocol,
        })),
      };

      const deploymentPatch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'orchard.my/service-updated-at': new Date().toISOString(),
              },
            },
            spec: {
              containers: existingDeployment.body.spec.template.spec.containers.map((c: any) =>
                c.name === containerName ? updatedContainer : c
              ),
            },
          },
        },
      };

      await appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        deploymentPatch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' },
        }
      );

      const existingService = await coreApi.readNamespacedService(serviceName, namespace);
      const serviceType = existingService.body.spec?.type || 'ClusterIP';
      const existingPorts = existingService.body.spec?.ports || [];
      const existingNodePortByName = new Map<string, number>();
      const existingNodePortBySignature = new Map<string, number>();

      existingPorts.forEach((entry) => {
        if (
          typeof entry.nodePort === 'number' &&
          Number.isInteger(entry.nodePort) &&
          entry.nodePort > 0
        ) {
          if (entry.name && entry.name.length > 0) {
            existingNodePortByName.set(entry.name, entry.nodePort);
          }
          const signature = `${entry.port}-${entry.protocol ?? 'TCP'}`.toLowerCase();
          existingNodePortBySignature.set(signature, entry.nodePort);
        }
      });

      const portsForService = normalizedPorts.map((port) => {
        let nodePortValue =
          typeof port.nodePort === 'number' &&
          Number.isInteger(port.nodePort) &&
          port.nodePort >= 30000 &&
          port.nodePort <= 32767
            ? port.nodePort
            : undefined;

        if (serviceType === 'NodePort' || serviceType === 'LoadBalancer') {
          const signature = `${port.servicePort}-${port.protocol}`.toLowerCase();
          const fallbackNodePort =
            nodePortValue ??
            existingNodePortByName.get(port.name) ??
            existingNodePortBySignature.get(signature);
          if (fallbackNodePort) {
            nodePortValue = fallbackNodePort;
          }
        } else {
          nodePortValue = undefined;
        }

        return {
          ...port,
          nodePort: nodePortValue,
        };
      });

      try {
        await coreApi.deleteNamespacedService(serviceName, namespace);
      } catch (deleteError) {
        if (deleteError.response?.statusCode !== 404) {
          throw deleteError;
        }
      }

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: existingService.body.metadata?.labels,
          annotations: existingService.body.metadata?.annotations,
        },
        spec: {
          type: serviceType,
          selector:
            existingService.body.spec?.selector || {
              'app.kubernetes.io/name': deploymentName,
            },
          ports: portsForService.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
            };
            if (
              (serviceType === 'NodePort' || serviceType === 'LoadBalancer') &&
              port.nodePort
            ) {
              entry.nodePort = port.nodePort;
            }
            return entry;
          }),
        },
      };

      if (existingService.body.spec?.clusterIP) {
        serviceBody.spec.clusterIP = existingService.body.spec.clusterIP;
      }
      if (existingService.body.spec?.clusterIPs) {
        serviceBody.spec.clusterIPs = existingService.body.spec.clusterIPs;
      }
      if (existingService.body.spec?.ipFamilyPolicy) {
        serviceBody.spec.ipFamilyPolicy = existingService.body.spec.ipFamilyPolicy;
      }
      if (existingService.body.spec?.ipFamilies) {
        serviceBody.spec.ipFamilies = existingService.body.spec.ipFamilies;
      }

      try {
        await coreApi.createNamespacedService(namespace, serviceBody);
      } catch (createError) {
        throw new BadRequestException({
          error: 'Failed to recreate service',
          message: createError.response?.body?.message || createError.message,
          details: createError.response?.body,
        });
      }

      const updatedService = await coreApi.readNamespacedService(serviceName, namespace);
      const updatedType = updatedService.body.spec?.type || serviceType;
      const mappedPorts = mapServicePorts(
        updatedService.body.spec?.ports,
        portsForService
      );

      let externalIp: string | null = null;
      if (updatedType === 'LoadBalancer') {
        const statusRecord = updatedService.body.status?.loadBalancer?.ingress?.[0];
        externalIp = statusRecord?.ip || statusRecord?.hostname || null;
      } else if (updatedType === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }

      return {
        success: true,
        namespace,
        deploymentName,
        serviceName,
        type: updatedType,
        ports: mappedPorts,
        externalIp,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Resource not found',
          message: `Deployment or service not found in namespace ${namespace}`,
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update service',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to update service',
        message: error.message,
      });
    }
  }

  async createDeploymentService(options: CreateAdditionalServiceOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    const sanitizedPorts = ensureUniqueServicePorts(
      sanitizePortEntries(Array.isArray(options.ports) ? options.ports : [])
    );

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    if (sanitizedPorts.length === 0) {
      throw new BadRequestException('At least one service port is required');
    }

    try {
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const deployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
      const containers = deployment.body.spec?.template?.spec?.containers;

      if (!containers || containers.length === 0) {
        throw new BadRequestException({
          error: 'Deployment has no containers',
          message: `Deployment "${deploymentName}" has no containers`,
        });
      }

      const targetContainer = containers[0];
      const existingPorts = Array.isArray(targetContainer.ports)
        ? targetContainer.ports
        : [];
      const mergedPorts: k8s.V1ContainerPort[] = [];
      const usedSignatures = new Set<string>();
      const usedNames = new Set<string>();

      const allocateName = (desired: string, fallbackIndex: number): string => {
        let base = (desired || `port-${fallbackIndex}`).trim().toLowerCase();
        base = base.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
        if (!base) base = `port-${fallbackIndex}`;
        if (base.length > 63) base = truncateK8sName(base, 63) || `port-${fallbackIndex}`;
        if (!usedNames.has(base)) {
          usedNames.add(base);
          return base;
        }
        let suffix = 1;
        while (true) {
          const tag = `-${suffix++}`;
          const trimmed = base.substring(0, Math.max(1, 63 - tag.length));
          const candidate = `${trimmed}${tag}`;
          if (!usedNames.has(candidate)) {
            usedNames.add(candidate);
            return candidate;
          }
        }
      };

      existingPorts.forEach((port, index) => {
        if (
          typeof port.containerPort === 'number' &&
          Number.isInteger(port.containerPort) &&
          port.containerPort > 0
        ) {
          const protocol = (port.protocol || 'TCP').toUpperCase();
          const signature = `${port.containerPort}-${protocol}`;
          usedSignatures.add(signature);
          mergedPorts.push({
            name: allocateName(port.name || '', index + 1),
            containerPort: port.containerPort,
            protocol,
          });
        }
      });

      sanitizedPorts.forEach((port, index) => {
        const signature = `${port.containerPort}-${port.protocol}`;
        if (!usedSignatures.has(signature)) {
          mergedPorts.push({
            name: allocateName(port.name || '', existingPorts.length + index + 1),
            containerPort: port.containerPort,
            protocol: port.protocol,
          });
          usedSignatures.add(signature);
        }
      });

      await appsApi.patchNamespacedDeployment(
        deploymentName,
        namespace,
        {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'orchard.my/service-updated-at': new Date().toISOString(),
                },
              },
              spec: {
                containers: containers.map((container) =>
                  container.name === targetContainer.name
                    ? {
                        ...container,
                        ports: mergedPorts,
                      }
                    : container
                ),
              },
            },
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' },
        }
      );

      const selectorLabels =
        deployment.body.spec?.selector?.matchLabels ||
        deployment.body.spec?.template?.metadata?.labels || {
          'app.kubernetes.io/name': deploymentName,
        };

      const requestedType = options.type || 'ClusterIP';

      const serviceBody: k8s.V1Service = {
        metadata: {
          name: serviceName,
          labels: {
            ...(deployment.body.spec?.template?.metadata?.labels || {}),
            'orchard.my/managed': 'true',
          },
        },
        spec: {
          type: requestedType,
          selector: selectorLabels,
          ports: sanitizedPorts.map((port) => {
            const entry: k8s.V1ServicePort = {
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
            };
            if (
              (requestedType === 'NodePort' || requestedType === 'LoadBalancer') &&
              port.nodePort
            ) {
              entry.nodePort = port.nodePort;
            }
            return entry;
          }),
        },
      };

      try {
        await coreApi.createNamespacedService(namespace, serviceBody);
      } catch (createError) {
        throw new BadRequestException({
          error: 'Failed to create service',
          message: createError.response?.body?.message || createError.message,
          details: createError.response?.body,
        });
      }

      const createdService = await coreApi.readNamespacedService(serviceName, namespace);
      const mappedPorts = mapServicePorts(
        createdService.body.spec?.ports,
        sanitizedPorts
      );
      const serviceType = createdService.body.spec?.type || requestedType;

      let externalIp: string | null = null;
      if (serviceType === 'LoadBalancer') {
        const statusRecord = createdService.body.status?.loadBalancer?.ingress?.[0];
        externalIp = statusRecord?.ip || statusRecord?.hostname || null;
      } else if (serviceType === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }

      return {
        type: serviceType,
        ports: mappedPorts,
        externalIp,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response?.statusCode === 404) {
        throw new NotFoundException({
          error: 'Deployment not found',
          message: `Deployment ${deploymentName} not found in namespace ${namespace}`,
        });
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to create service',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to create service',
        message: error.message,
      });
    }
  }

  async deleteDeploymentService(options: DeleteDeploymentServiceOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const deploymentName = String(options.deploymentName || '').trim();
    const serviceName = String(options.serviceName || '').trim();

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!deploymentName) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
      const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

      try {
        await coreApi.deleteNamespacedService(serviceName, namespace);
      } catch (deleteError) {
        if (deleteError.response?.statusCode !== 404) {
          throw new BadRequestException({
            error: 'Failed to delete service',
            message: deleteError.response?.body?.message || deleteError.message,
            details: deleteError.response?.body,
          });
        }
      }

      if (options.remainingPorts) {
        const sanitizedRemaining = ensureUniqueServicePorts(
          sanitizePortEntries(options.remainingPorts)
        );

        try {
          const deployment = await appsApi.readNamespacedDeployment(deploymentName, namespace);
          const containers = deployment.body.spec?.template?.spec?.containers;

          if (containers && containers.length > 0) {
            const targetContainer = containers[0];
            const updatedContainer = {
              ...targetContainer,
              ports: sanitizedRemaining.map((port) => ({
                name: port.name,
                containerPort: port.containerPort,
                protocol: port.protocol,
              })),
            };

            await appsApi.patchNamespacedDeployment(
              deploymentName,
              namespace,
              {
                spec: {
                  template: {
                    metadata: {
                      annotations: {
                        'orchard.my/service-updated-at': new Date().toISOString(),
                      },
                    },
                    spec: {
                      containers: containers.map((container) =>
                        container.name === targetContainer.name ? updatedContainer : container
                      ),
                    },
                  },
                },
              },
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                headers: { 'Content-Type': 'application/merge-patch+json' },
              }
            );
          }
        } catch (deploymentError) {
          if (deploymentError.response?.statusCode !== 404) {
            throw new BadRequestException({
              error: 'Failed to update deployment ports',
              message: deploymentError.response?.body?.message || deploymentError.message,
              details: deploymentError.response?.body,
            });
          }
        }
      }

      return {
        success: true,
      };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to delete service',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to delete service',
        message: error.message,
      });
    }
  }

  async updateServiceExposure(options: UpdateServiceExposureOptions) {
    this.ensureKubeConfig();

    const namespace = String(options.namespace || '').trim();
    const serviceName = String(options.serviceName || '').trim();
    let type: 'LoadBalancer' | 'NodePort' | 'ClusterIP' = 'ClusterIP';
    if (options.type === 'LoadBalancer') type = 'LoadBalancer';
    else if (options.type === 'NodePort') type = 'NodePort';

    if (!namespace) {
      throw new BadRequestException('Namespace parameter is required');
    }

    if (!serviceName) {
      throw new BadRequestException('Service name is required');
    }

    try {
      const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const patch = {
        spec: {
          type,
        },
      };

      await coreApi.patchNamespacedService(
        serviceName,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: {
            'Content-Type': 'application/strategic-merge-patch+json',
          },
        }
      );

      const updated = await coreApi.readNamespacedService(serviceName, namespace);
      let externalIp: string | null = null;
      if (type === 'LoadBalancer') {
        const ingressStatus = updated.body.status?.loadBalancer?.ingress?.[0];
        externalIp = ingressStatus?.ip || ingressStatus?.hostname || null;
      } else if (type === 'NodePort') {
        externalIp = await this.getDefaultNodeIp(coreApi);
      }
      const ports = mapServicePorts(updated.body.spec?.ports);

      return {
        success: true,
        namespace,
        serviceName,
        type,
        externalIp,
        ports,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.response) {
        throw new BadRequestException({
          error: 'Failed to update service exposure',
          message: error.response.body?.message || error.message,
          details: error.response.body,
        });
      }

      throw new BadRequestException({
        error: 'Failed to update service exposure',
        message: error.message,
      });
    }
  }




  private publicServiceName(clusterName: string): string {
    return truncateK8sName(`${clusterName}-public`, 63);
  }

  private sharedIpAnnotations(ip: string): Record<string, string> {
    return {
      'lbipam.cilium.io/sharing-key': `shared-${ip.replace(/[^0-9a-zA-Z]/g, '-')}`,
      'lbipam.cilium.io/sharing-cross-namespace': '*',
    };
  }

  async listInUsePortsOnIp(loadBalancerIp: string): Promise<number[]> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listServiceForAllNamespaces();
    const ports = new Set<number>();
    for (const svc of body.items) {
      if (svc.spec?.type !== 'LoadBalancer') continue;
      const svcIp = svc.spec?.loadBalancerIP
        || svc.status?.loadBalancer?.ingress?.[0]?.ip;
      if (svcIp !== loadBalancerIp) continue;
      for (const p of svc.spec?.ports || []) {
        if (typeof p.port === 'number') ports.add(p.port);
      }
    }
    return Array.from(ports);
  }

  async exposeCnpgClusterPublic(options: {
    namespace: string;
    clusterName: string;
    loadBalancerIp: string;
    port: number;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const svcName = this.publicServiceName(options.clusterName);

    const body: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': options.clusterName,
        },
        annotations: this.sharedIpAnnotations(options.loadBalancerIp),
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerIP: options.loadBalancerIp,
        externalTrafficPolicy: 'Cluster',
        selector: {
          'cnpg.io/cluster': options.clusterName,
          'cnpg.io/instanceRole': 'primary',
        },
        ports: [
          { name: 'postgres', port: options.port, targetPort: 5432, protocol: 'TCP' },
        ],
      },
    };

    try {
      await coreApi.readNamespacedService(svcName, options.namespace);
      await coreApi.replaceNamespacedService(svcName, options.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(options.namespace, body);
      } else {
        throw e;
      }
    }
  }

  async unexposeCnpgCluster(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const svcName = this.publicServiceName(clusterName);
    try {
      await coreApi.deleteNamespacedService(svcName, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    try {
      await this.deletePublicDatabaseNetworkPolicy(namespace, clusterName);
    } catch (e: any) {
      console.error(`[K8s/netpol] Failed to delete public NetworkPolicy: ${e?.message}`);
    }
  }

  private publicDatabaseNetworkPolicyName(clusterName: string): string {
    return truncateK8sName(`${clusterName}-allow-public`, 63);
  }

  async upsertPublicDatabaseNetworkPolicy(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDatabaseNetworkPolicyName(clusterName);

    const body: k8s.V1NetworkPolicy = {
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': clusterName,
        },
      },
      spec: {
        // Target the CNPG primary pod of this cluster.
        podSelector: {
          matchLabels: {
            'cnpg.io/cluster': clusterName,
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
        ],
      },
    };

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deletePublicDatabaseNetworkPolicy(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDatabaseNetworkPolicyName(clusterName);
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  // ── Public deployment-port exposure (MetalLB LoadBalancer, TCP/UDP passthrough) ──

  private readonly PUBLIC_DEPLOYMENT_BASE_DOMAIN = process.env.PUBLIC_DEPLOYMENT_DOMAIN || 'public.orchard.my';

  publicDeploymentBaseDomain(): string {
    return this.PUBLIC_DEPLOYMENT_BASE_DOMAIN;
  }

  private publicDeploymentServiceName(deploymentName: string, port: number, protocol: string): string {
    const proto = protocol.toLowerCase() === 'udp' ? 'u' : 't';
    return truncateK8sName(`${deploymentName}-pub-${proto}${port}`, 63);
  }

  async exposeDeploymentPortPublic(options: {
    namespace: string;
    deploymentName: string;
    loadBalancerIp: string;
    publicPort: number;
    targetPort: number;
    protocol: string;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const protocol = options.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const svcName = this.publicDeploymentServiceName(options.deploymentName, options.publicPort, protocol);

    const body: k8s.V1Service = {
      metadata: {
        name: svcName,
        namespace: options.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'app.kubernetes.io/name': options.deploymentName,
          'orchard.my/public-deployment': options.deploymentName,
        },
        annotations: this.sharedIpAnnotations(options.loadBalancerIp),
      },
      spec: {
        type: 'LoadBalancer',
        loadBalancerIP: options.loadBalancerIp,
        externalTrafficPolicy: 'Cluster',
        selector: {
          'app.kubernetes.io/name': options.deploymentName,
        },
        ports: [
          {
            name: `pub-${protocol.toLowerCase()}-${options.publicPort}`,
            port: options.publicPort,
            targetPort: options.targetPort,
            protocol,
          },
        ],
      },
    };

    try {
      await coreApi.readNamespacedService(svcName, options.namespace);
      await coreApi.replaceNamespacedService(svcName, options.namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(options.namespace, body);
      } else {
        throw e;
      }
    }
  }

  async unexposeDeploymentPortPublic(options: {
    namespace: string;
    deploymentName: string;
    publicPort: number;
    protocol: string;
  }): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const protocol = options.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const svcName = this.publicDeploymentServiceName(options.deploymentName, options.publicPort, protocol);
    try {
      await coreApi.deleteNamespacedService(svcName, options.namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async unexposeAllDeploymentPortsPublic(namespace: string, deploymentName: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body } = await coreApi.listNamespacedService(
        namespace, undefined, undefined, undefined, undefined,
        `orchard.my/public-deployment=${deploymentName}`,
      );
      for (const svc of body.items) {
        const n = svc.metadata?.name;
        if (!n) continue;
        try {
          await coreApi.deleteNamespacedService(n, namespace);
        } catch (e: any) {
          if (e.response?.statusCode !== 404) throw e;
        }
      }
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  private publicDeploymentNetworkPolicyName(deploymentName: string): string {
    return truncateK8sName(`${deploymentName}-allow-public`, 63);
  }

  async upsertPublicDeploymentNetworkPolicy(
    namespace: string,
    deploymentName: string,
    ports: { port: number; protocol: string }[],
  ): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDeploymentNetworkPolicyName(deploymentName);

    if (ports.length === 0) {
      await this.deletePublicDeploymentNetworkPolicy(namespace, deploymentName);
      return;
    }

    const body: k8s.V1NetworkPolicy = {
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'app.kubernetes.io/name': deploymentName,
        },
      },
      spec: {
        podSelector: {
          matchLabels: { 'app.kubernetes.io/name': deploymentName },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
            ports: ports.map((p) => ({
              protocol: p.protocol.toUpperCase() === 'UDP' ? 'UDP' : 'TCP',
              port: p.port,
            })),
          },
        ],
      },
    };

    try {
      await networkingApi.readNamespacedNetworkPolicy(name, namespace);
      await networkingApi.replaceNamespacedNetworkPolicy(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await networkingApi.createNamespacedNetworkPolicy(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deletePublicDeploymentNetworkPolicy(namespace: string, deploymentName: string): Promise<void> {
    this.ensureKubeConfig();
    const networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
    const name = this.publicDeploymentNetworkPolicyName(deploymentName);
    try {
      await networkingApi.deleteNamespacedNetworkPolicy(name, namespace);
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }
}
