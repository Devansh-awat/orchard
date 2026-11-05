export const REGISTRY_PREFIX_LABEL = 'orchard.my/registry-prefix';
export const REGISTRY_FOREIGN_ANNOTATION = 'orchard.my/registry-foreign';
export const REGISTRY_OWN_ANNOTATION = 'orchard.my/registry-own';
export const REGISTRY_POLICY_NAME = 'orchard-tenant-images';

export type RegistryPolicyMode = 'enforce' | 'warn' | 'off';

export function registryPolicyMode(value: string | undefined): RegistryPolicyMode {
  const mode = (value || '').trim().toLowerCase();
  if (mode === 'enforce' || mode === 'off') return mode;
  return 'warn';
}

function celString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function annotationList(key: string): string {
  const annotations = 'namespaceObject.metadata.annotations';
  return `has(${annotations}) && ${celString(key)} in ${annotations} ? ${annotations}[${celString(key)}].split(',') : []`;
}

export function registryImagePolicy(hosts: string[], registryProject: string): object {
  const platformHosts = hosts.flatMap((host) => [host, `${host}:443`].map(celString)).join(', ');
  const repo = "i.lowerAscii().split('/')[2].split('@')[0].split(':')[0]";
  const ownRepo = [
    `${repo}.startsWith(variables.prefix + '-')`,
    `(variables.own.exists(o, o == ${repo}) || !variables.foreign.exists(f, ${repo}.startsWith(f + '-')))`
  ].join(' && ');
  const onPlatform = "variables.hosts.exists(h, h == i.lowerAscii().split('/')[0])";
  const allowed = [
    "!i.lowerAscii().split('/')[0].matches('^(localhost|127(\\\\.[0-9]+){3}|\\\\[::1\\\\]|0\\\\.0\\\\.0\\\\.0)(:[0-9]+)?$')",
    `(!${onPlatform} || (i.split('/').size() == 3 && i.lowerAscii().split('/')[1] == ${celString(registryProject)} && ${ownRepo}))`
  ].join(' && ');
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: { name: REGISTRY_POLICY_NAME },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        namespaceSelector: {
          matchExpressions: [{ key: REGISTRY_PREFIX_LABEL, operator: 'Exists' }]
        },
        resourceRules: [
          {
            apiGroups: [''],
            apiVersions: ['v1'],
            operations: ['CREATE', 'UPDATE'],
            resources: ['pods', 'pods/ephemeralcontainers']
          }
        ]
      },
      variables: [
        { name: 'hosts', expression: `[${platformHosts}]` },
        {
          name: 'images',
          expression:
            'object.spec.containers.map(c, c.image) + (has(object.spec.initContainers) ? object.spec.initContainers.map(c, c.image) : []) + (has(object.spec.ephemeralContainers) ? object.spec.ephemeralContainers.map(c, c.image) : [])'
        },
        {
          name: 'prefix',
          expression: `namespaceObject.metadata.labels[${celString(REGISTRY_PREFIX_LABEL)}]`
        },
        { name: 'foreign', expression: annotationList(REGISTRY_FOREIGN_ANNOTATION) },
        { name: 'own', expression: annotationList(REGISTRY_OWN_ANNOTATION) }
      ],
      validations: [
        {
          expression: `variables.images.all(i, ${allowed})`,
          message: "This pod names an image from another project's registry space"
        }
      ]
    }
  };
}

export function registryImagePolicyBinding(mode: Exclude<RegistryPolicyMode, 'off'>): object {
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: { name: REGISTRY_POLICY_NAME },
    spec: {
      policyName: REGISTRY_POLICY_NAME,
      validationActions: mode === 'enforce' ? ['Deny'] : ['Warn', 'Audit']
    }
  };
}

export interface RegistryPolicyProject {
  namespace: string;
  environments: string[];
  repos: string[];
}

export interface NamespaceRegistryMeta {
  prefix: string;
  foreign: string | null;
  own: string | null;
}

export function namespaceRegistryMeta(
  projects: RegistryPolicyProject[]
): Map<string, NamespaceRegistryMeta> {
  const result = new Map<string, NamespaceRegistryMeta>();
  for (const project of projects) {
    const foreign = projects
      .filter(
        (other) =>
          other.namespace !== project.namespace &&
          other.namespace.startsWith(`${project.namespace}-`)
      )
      .map((other) => other.namespace)
      .sort();
    const own = [...new Set(project.repos)]
      .filter((repo) => foreign.some((prefix) => repo.startsWith(`${prefix}-`)))
      .sort();
    const meta = {
      prefix: project.namespace,
      foreign: foreign.length ? foreign.join(',') : null,
      own: own.length ? own.join(',') : null
    };
    for (const namespace of new Set([project.namespace, ...project.environments])) {
      result.set(namespace, meta);
    }
  }
  return result;
}

export function repoFromImage(image: string): string {
  return (image.split('/').pop() ?? image).split('@')[0].split(':')[0];
}
