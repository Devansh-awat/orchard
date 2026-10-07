import { z } from 'zod';
import type { RouteAttachment } from '../types';

const registryCredential = z.object({
  id: z.string().uuid(),
  registry: z.string().describe('Normalised registry host, e.g. ghcr.io or docker.io'),
  username: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /projects/:projectId/registry-credentials': {
    summary: 'List the registries this project can pull private images from',
    scope: 'read',
    response: z.array(registryCredential)
  },
  'PUT /projects/:projectId/registry-credentials': {
    summary: 'Add or replace the credential for one registry',
    scope: 'deploy',
    request: z.object({
      registry: z
        .string()
        .describe('Registry host such as ghcr.io, docker.io or registry.gitlab.com'),
      username: z.string(),
      password: z
        .string()
        .describe('Password or access token; verified against the registry before it is stored')
    }),
    response: registryCredential
  },
  'DELETE /projects/:projectId/registry-credentials/:id': {
    summary: 'Remove a registry credential',
    scope: 'deploy',
    response: z.object({ success: z.literal(true) })
  }
};
