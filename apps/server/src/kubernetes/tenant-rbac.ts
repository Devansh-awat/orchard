import * as k8s from '@kubernetes/client-node';

export const TENANT_SECRETS_ROLE = 'orchard-server-tenant-secrets';

const labels = {
  'app.kubernetes.io/name': 'server',
  'app.kubernetes.io/managed-by': 'leaf'
};

const serverSubject = (serverNamespace: string): k8s.RbacV1Subject => ({
  kind: 'ServiceAccount',
  name: 'orchard-server',
  namespace: serverNamespace
});

export function tenantSecretsRole(namespace: string): k8s.V1Role {
  return {
    metadata: { name: TENANT_SECRETS_ROLE, namespace, labels },
    rules: [
      {
        apiGroups: [''],
        resources: ['secrets', 'configmaps'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
      }
    ]
  };
}

export function tenantSecretsBinding(
  namespace: string,
  serverNamespace: string,
  clusterRole: string | undefined
): k8s.V1RoleBinding {
  const roleRef = clusterRole
    ? { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: clusterRole }
    : { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: TENANT_SECRETS_ROLE };
  return {
    metadata: { name: TENANT_SECRETS_ROLE, namespace, labels },
    roleRef,
    subjects: [serverSubject(serverNamespace)]
  };
}
