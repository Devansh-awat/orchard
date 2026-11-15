import { z } from 'zod';
import type { RouteAttachment } from '../types';

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {};

export const publicEndpointStatusSchema = z.object({
  state: z.enum(['ready', 'pending', 'failed', 'unknown']),
  addresses: z.array(z.string()),
  reason: z.string().nullable()
});
