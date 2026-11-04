import { Controller, Get, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { etagMatches, readContractsFile } from './contracts-files';

@Controller()
export class AgentSpecController {
  @Public()
  @Get('agent-spec.json')
  agentSpec(@Req() req: Request, @Res() res: Response) {
    this.send('agent-spec.json', req, res);
  }

  @Public()
  @Get('openapi.json')
  openapi(@Req() req: Request, @Res() res: Response) {
    this.send('openapi.json', req, res);
  }

  private send(name: string, req: Request, res: Response) {
    const file = readContractsFile(name);
    if (!file) throw new NotFoundException(`${name} isn't bundled with this server`);
    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.setHeader('Vary', 'Accept-Encoding');
    if (etagMatches(req.headers['if-none-match'], file.etag)) {
      res.status(304).end();
      return;
    }
    res.type('application/json').status(200).send(file.body);
  }
}
