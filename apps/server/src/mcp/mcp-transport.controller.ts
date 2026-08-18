import { Controller, Post, Get, Delete, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpTransportService } from './mcp-transport.service';

// One stateless Streamable HTTP endpoint. POST carries JSON-RPC; GET opens the
// optional server->client stream; DELETE is a no-op teardown in the stateless
// model. The v2 handler classifies era (2026-07-28 vs legacy 2025) and method
// internally, so all three verbs funnel through the same dispatch.
@Controller()
export class McpTransportController {
  constructor(
    @Inject(McpTransportService) private readonly transport: McpTransportService,
  ) {}

  @Post()
  handlePost(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res);
  }

  @Get()
  handleGet(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res);
  }

  @Delete()
  handleDelete(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res);
  }
}
