import { z } from 'zod';

export const pageInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Page size (default 50). Results carry total and nextCursor.'),
  cursor: z.string().optional().describe('nextCursor from the previous page')
};
