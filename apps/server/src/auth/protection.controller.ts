import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Request,
  Res,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { Public, Auth } from './decorators';
import { ProtectionService } from './protection.service';

@Controller('auth/protect')
export class ProtectionController {
  constructor(private readonly protection: ProtectionService) {}

  @Public()
  @Get('check')
  async check(@Request() req, @Res() res: Response) {
    const host = (req.headers[':authority'] || req.headers['host'] || '').toString().toLowerCase();
    const originalPath = (req.headers['x-original-url'] || req.headers[':path'] || req.url || '/').toString();
    const cookieHeader = req.headers['cookie']?.toString();
    const bypassHeader = req.headers['x-orchard-protection-bypass']?.toString();
    const authorizationHeader = req.headers['authorization']?.toString();

    const decision = await this.protection.checkProtection(
      host,
      originalPath,
      cookieHeader,
      bypassHeader,
      authorizationHeader,
    );

    if (decision.allow) {
      return res.status(HttpStatus.OK).send('ok');
    }

    if (decision.headers) {
      for (const [key, value] of Object.entries(decision.headers)) {
        res.setHeader(key, value);
      }
    }
    return res.status(decision.status || 403).send('');
  }

  @Public()
  @Get('info')
  async info(@Query('ingressId') ingressId: string) {
    if (!ingressId) throw new BadRequestException('ingressId required');
    const info = await this.protection.getIngressInfo(ingressId);
    if (!info) throw new NotFoundException();
    return info;
  }

  @Auth()
  @Post('exchange/orchard')
  async exchangeOrchard(
    @Request() req,
    @Body() body: { ingressId: string; returnTo: string },
  ) {
    if (!body.ingressId || !body.returnTo) {
      throw new BadRequestException('ingressId and returnTo required');
    }

    await this.protection.validateReturnTo(body.ingressId, body.returnTo);

    const hasAccess = await this.protection.checkUserAccess(body.ingressId, req.user.sub);
    if (!hasAccess) throw new ForbiddenException('No access to this deployment');

    const token = await this.protection.generateExchangeToken(body.ingressId, req.user.sub);
    const separator = body.returnTo.includes('?') ? '&' : '?';
    return { redirectUrl: `${body.returnTo}${separator}__orchard_token=${token}` };
  }

  @Public()
  @Post('exchange/password')
  async exchangePassword(
    @Body() body: { ingressId: string; password: string; returnTo: string },
  ) {
    if (!body.ingressId || !body.password || !body.returnTo) {
      throw new BadRequestException('ingressId, password, and returnTo required');
    }

    await this.protection.validateReturnTo(body.ingressId, body.returnTo);

    const valid = await this.protection.verifyPassword(body.ingressId, body.password);
    if (!valid) throw new ForbiddenException('Invalid password');

    const token = await this.protection.generateExchangeToken(body.ingressId, 'password');
    const separator = body.returnTo.includes('?') ? '&' : '?';
    return { redirectUrl: `${body.returnTo}${separator}__orchard_token=${token}` };
  }
}
