import * as k8s from '@kubernetes/client-node';

export function tailscaleRoleRules(secretName: string): k8s.V1PolicyRule[] {
  return [
    {
      apiGroups: [''],
      resources: ['secrets'],
      verbs: ['get', 'update', 'patch'],
      resourceNames: [secretName]
    },
    { apiGroups: [''], resources: ['events'], verbs: ['get', 'create', 'patch'] }
  ];
}
