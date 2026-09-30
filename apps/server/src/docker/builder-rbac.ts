import * as k8s from '@kubernetes/client-node';

export const BUILDER_SERVICE_ACCOUNT = 'image-builder';
export const BUILDER_ROLE = 'image-builder-role';

export const BUILDER_ROLE_RULES: k8s.V1PolicyRule[] = [
  { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list', 'watch'] },
  { apiGroups: [''], resources: ['secrets'], verbs: ['get'] },
  { apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'list', 'watch'] }
];
