import type { RouteAttachment } from '../types';
import { attachments as common } from './common';
import { attachments as databases } from './databases';
import { attachments as deployments } from './deployments';
import { attachments as events } from './events';
import { attachments as jobs } from './jobs';

export const attachments: Record<string, RouteAttachment> = {
  ...common,
  ...databases,
  ...deployments,
  ...events,
  ...jobs,
};
