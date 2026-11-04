import type { NestExpressApplication } from '@nestjs/platform-express';

export const MCP_MAX_BODY_BYTES = 100 * 1024;

export function applyMcpBodyLimits(app: NestExpressApplication) {
  app.useBodyParser('json', { limit: MCP_MAX_BODY_BYTES });
  app.useBodyParser('urlencoded', { limit: MCP_MAX_BODY_BYTES, extended: true });
}
