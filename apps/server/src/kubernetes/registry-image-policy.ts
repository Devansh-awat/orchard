import {
  isLoopbackHost,
  parseImageRef,
  repositoryName,
  sameRegistryHost
} from '../projects/image-ref';

export const REGISTRY_PREFIX_LABEL = 'orchard.my/registry-prefix';
export const REGISTRY_FOREIGN_ANNOTATION = 'orchard.my/registry-foreign';
export const REGISTRY_OWN_ANNOTATION = 'orchard.my/registry-own';
export const REGISTRY_POLICY_NAME = 'orchard-tenant-images';

export type RegistryPolicyMode = 'enforce' | 'warn' | 'off';
export type RegistryPolicySetting = RegistryPolicyMode | 'auto';

export function registryPolicyMode(value: string | undefined): RegistryPolicySetting {
  const mode = (value || '').trim().toLowerCase();
  if (mode === '' || mode === 'auto') return 'auto';
  if (mode === 'warn' || mode === 'off') return mode;
  return 'enforce';
}

export function platformHostVariants(host: string): string[] {
  const bare = host
    .toLowerCase()
    .replace(/:(443|80)$/, '')
    .replace(/\.+$/, '');
  return [...new Set([bare, `${bare}.`].flatMap((h) => [h, `${h}:443`, `${h}:80`]))];
}

export function imageAllowedInNamespace(
  image: string,
  meta: NamespaceRegistryMeta,
  hosts: string[],
  registryProject: string
): boolean {
  const ref = parseImageRef(image);
  if (!ref?.host) return true;
  if (isLoopbackHost(ref.host)) return false;
  if (!hosts.some((host) => sameRegistryHost(ref.host!, host))) return true;
  const parts = ref.repository.split('/');
  if (parts.length !== 2 || parts[0] !== registryProject) return false;
  const repo = parts[1];
  if (!repo.startsWith(`${meta.prefix}-`)) return false;
  const own = (meta.own ?? '').split(',').filter(Boolean);
  const foreign = (meta.foreign ?? '').split(',').filter(Boolean);
  return own.includes(repo) || !foreign.some((prefix) => repo.startsWith(`${prefix}-`));
}

export function registryPolicyBlockers(
  projects: { namespace: string; images: string[] }[],
  meta: Map<string, NamespaceRegistryMeta>,
  hosts: string[],
  registryProject: string,
  pinnedImages: string[] = []
): string[] {
  const blockers: string[] = [];
  for (const project of projects) {
    const projectMeta = meta.get(project.namespace);
    if (!projectMeta) continue;
    for (const image of project.images) {
      if (!imageAllowedInNamespace(image, projectMeta, hosts, registryProject)) {
        blockers.push(`${project.namespace}: ${image}`);
      }
    }
  }
  for (const image of pinnedImages) {
    const ref = parseImageRef(image);
    if (ref?.host && hosts.some((host) => sameRegistryHost(ref.host!, host))) {
      blockers.push(`pinned image: ${image}`);
    }
  }
  return blockers;
}

function celString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function annotationList(key: string): string {
  const annotations = 'namespaceObject.metadata.annotations';
  return `has(${annotations}) && ${celString(key)} in ${annotations} ? ${annotations}[${celString(key)}].split(',') : []`;
}

export function registryImagePolicy(hosts: string[], registryProject: string): object {
  const platformHosts = [...new Set(hosts.flatMap(platformHostVariants))].map(celString).join(', ');
  const repo = "i.lowerAscii().split('/')[2].split('@')[0].split(':')[0]";
  const ownRepo = [
    `${repo}.startsWith(variables.prefix + '-')`,
    `(variables.own.exists(o, o == ${repo}) || !variables.foreign.exists(f, ${repo}.startsWith(f + '-')))`
  ].join(' && ');
  const onPlatform = "variables.hosts.exists(h, h == i.lowerAscii().split('/')[0])";
  const allowed = [
    "!i.lowerAscii().split('/')[0].matches('^(localhost\\\\.?|127(\\\\.[0-9]+){0,3}\\\\.?|0(\\\\.0){0,3}\\\\.?|\\\\[::1?\\\\]|\\\\[::ffff:[0-9a-f:.]+\\\\])(:[0-9]+)?$')",
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
  const ref = parseImageRef(image);
  if (ref) return repositoryName(ref);
  return (image.split('/').pop() ?? image).split('@')[0].split(':')[0];
}
