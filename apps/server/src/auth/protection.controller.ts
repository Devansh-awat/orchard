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
  NotFoundException
} from '@nestjs/common';
import { Response } from 'express';
import { Public, Auth } from './decorators';
import { ProtectionService } from './protection.service';
import { RateLimitService } from './rate-limit.service';
import { TurnstileService } from './turnstile.service';
import { getClientIp } from './client-ip';

@Controller('auth/protect')
export class ProtectionController {
  constructor(
    private readonly protection: ProtectionService,
    private readonly rateLimit: RateLimitService,
    private readonly turnstile: TurnstileService
  ) {}

  @Public()
  @Get('check')
  async check(@Request() req, @Res() res: Response) {
    const host = (req.headers[':authority'] || req.headers['host'] || '').toString().toLowerCase();
    const originalPath = (
      req.headers['x-original-url'] ||
      req.headers[':path'] ||
      req.url ||
      '/'
    ).toString();
    const cookieHeader = req.headers['cookie']?.toString();
    const bypassHeader = req.headers['x-orchard-protection-bypass']?.toString();
    const authorizationHeader = req.headers['authorization']?.toString();

    const decision = await this.protection.checkProtection(
      host,
      originalPath,
      cookieHeader,
      bypassHeader,
      authorizationHeader,
      getClientIp(req)
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
    return { ...info, turnstileSiteKey: this.turnstile.siteKey() };
  }

  @Auth()
  @Post('exchange/orchard')
  async exchangeOrchard(@Request() req, @Body() body: { ingressId: string; returnTo: string }) {
    if (!body.ingressId || !body.returnTo) {
      throw new BadRequestException('ingressId and returnTo required');
    }

    const returnTo = await this.protection.validateReturnTo(body.ingressId, body.returnTo);

    const hasAccess = await this.protection.checkUserAccess(body.ingressId, req.user.sub);
    if (!hasAccess) throw new ForbiddenException("You don't have access to this app");

    const token = await this.protection.generateExchangeToken(body.ingressId, req.user.sub);
    const separator = returnTo.includes('?') ? '&' : '?';
    return { redirectUrl: `${returnTo}${separator}__orchard_token=${token}` };
  }

  @Public()
  @Post('exchange/password')
  async exchangePassword(
    @Request() req,
    @Body() body: { ingressId: string; password: string; returnTo: string }
  ) {
    if (!body.ingressId || !body.password || !body.returnTo) {
      throw new BadRequestException('ingressId, password, and returnTo required');
    }

    const returnTo = await this.protection.validateReturnTo(body.ingressId, body.returnTo);

    // One guess costs an attacker one bcrypt compare, which is nowhere near
    // expensive enough to stand alone: the per-IP bucket throttles a single
    // script, and the per-ingress bucket bounds the same guess spread across
    // many addresses. Scoping the IP bucket to the ingress keeps one deployment
    // under attack from locking a shared NAT out of every other deployment.
    const ip = getClientIp(req);
    const ipKey = `${body.ingressId}:${ip}`;
    const { pressured } = await this.rateLimit.checkRateLimits('protection_password', {
      ip: ipKey,
      identities: [[body.ingressId, 'ingress']]
    });
    if (pressured) await this.rateLimit.slowDown();
    await this.turnstile.verifyRequest(req, 'protection', ip);

    const valid = await this.protection.verifyPassword(body.ingressId, body.password);
    if (!valid) {
      throw new ForbiddenException('Invalid password');
    }

    // Only the address that proved it knows the password gets its bucket back.
    // The per-ingress bucket is left alone on purpose: clearing it would let a
    // guess run indefinitely on any site whose password is shared widely enough
    // that somebody signs in successfully every few minutes.
    await this.rateLimit.resetRateLimit(ipKey, 'ip', 'protection_password');

    const token = await this.protection.generateExchangeToken(body.ingressId, 'password');
    const separator = returnTo.includes('?') ? '&' : '?';
    return { redirectUrl: `${returnTo}${separator}__orchard_token=${token}` };
  }
}
