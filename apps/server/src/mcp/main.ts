import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { applyMcpBodyLimits } from './body-limit';
import { McpModule } from './mcp.module';
import { loadMcpGrafts } from '../grafts/mcp';

dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '.env'), override: false });
dotenv.config({ path: resolve(__dirname, '../../.env'), override: false });

async function bootstrap() {
  await loadMcpGrafts();
  const app = await NestFactory.create<NestExpressApplication>(McpModule, { bodyParser: false });

  app.enableCors();
  applyMcpBodyLimits(app);

  const port = parseInt(process.env.MCP_PORT || '3100', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';
  await app.listen(port, host);

  console.error(`Orchard MCP Server (NestJS) listening on http://${host}:${port}/`);
}

bootstrap();
