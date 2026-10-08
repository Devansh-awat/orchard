import type { RouteAttachment } from '../types';
import { attachments as common } from './common';
import { attachments as databases } from './databases';
import { attachments as deployments } from './deployments';
import { attachments as events } from './events';
import { attachments as integrations } from './integrations';
import { attachments as jobs } from './jobs';
import { attachments as registryCredentials } from './registry-credentials';
import { attachments as sandboxes } from './sandboxes';
import { attachments as sshIdentities } from './ssh-identities';

export const attachments: Record<string, RouteAttachment> = {
  ...common,
  ...databases,
  ...deployments,
  ...events,
  ...integrations,
  ...jobs,
  ...registryCredentials,
  ...sandboxes,
  ...sshIdentities
};
