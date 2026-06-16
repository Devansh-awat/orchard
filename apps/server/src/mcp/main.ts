import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { McpModule } from './mcp.module';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '.env'), override: false });
dotenv.config({ path: resolve(__dirname, '../../.env'), override: false });

async function bootstrap() {
  const app = await NestFactory.create(McpModule);

  app.enableCors();

  const port = parseInt(process.env.MCP_PORT || '3100', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';
  await app.listen(port, host);

  console.error(`Orchard MCP Server (NestJS) listening on http://${host}:${port}/`);
}

bootstrap();
