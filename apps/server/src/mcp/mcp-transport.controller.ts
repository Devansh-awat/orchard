import { Controller, Post, Get, Delete, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpTransportService } from './mcp-transport.service';

@Controller()
export class McpTransportController {
  constructor(@Inject(McpTransportService) private readonly transport: McpTransportService) {}

  @Post()
  handlePost(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res, 'normal');
  }

  @Get()
  handleGet(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res, 'normal');
  }

  @Delete()
  handleDelete(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res, 'normal');
  }

  @Post('compact')
  handleCompactPost(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res, 'compact');
  }

  @Get('compact')
  handleCompactGet(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res, 'compact');
  }

  @Delete('compact')
  handleCompactDelete(@Req() req: Request, @Res() res: Response) {
    return this.transport.handle(req, res, 'compact');
  }
}
