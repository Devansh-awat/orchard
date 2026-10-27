import { z } from 'zod4';

const record = z.looseObject({});

export const pageOutput = z.object({
  items: z.array(record),
  total: z.number(),
  nextCursor: z.string().optional()
});

export const findOutput = z.object({
  query: z.string().nullable(),
  results: z.array(
    z.looseObject({
      kind: z.enum(['organization', 'project', 'deployment', 'database']),
      id: z.string()
    })
  ),
  partial: z.boolean().optional(),
  errors: z.array(z.object({ kind: z.string(), error: z.string() })).optional()
});

export const deploymentOutput = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  status: z.string().nullable().optional(),
  replicas: z.number().nullable().optional(),
  projectId: z.string().nullable().optional()
});

export const rolloutOutput = z.looseObject({
  phase: z.string(),
  terminal: z.boolean().optional(),
  releaseId: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  hint: z.string().nullable().optional()
});
