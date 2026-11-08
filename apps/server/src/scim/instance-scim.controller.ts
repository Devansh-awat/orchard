import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Public, SuperAdmin } from '../auth/decorators';
import { InstanceScimService, instanceScimError } from './instance-scim.service';

const SCIM_CONTENT_TYPE = 'application/scim+json';

@Injectable()
export class InstanceScimGuard implements CanActivate {
  constructor(private readonly scim: InstanceScimService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!(await this.scim.resolveToken(token))) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="SCIM"');
      throw instanceScimError(401, 'Invalid or missing instance SCIM token');
    }
    return true;
  }
}

@Public()
@UseGuards(InstanceScimGuard)
@Controller('scim/instance/v2')
export class InstanceScimController {
  constructor(private readonly scim: InstanceScimService) {}

  private send(res: Response, body: unknown, status = 200) {
    res.status(status).setHeader('Content-Type', SCIM_CONTENT_TYPE);
    res.send(JSON.stringify(body));
  }

  @Get('ServiceProviderConfig')
  config(@Res() res: Response) {
    this.send(res, this.scim.serviceProviderConfig());
  }

  @Get('Users')
  async list(@Query() q: Record<string, string>, @Res() res: Response) {
    this.send(res, await this.scim.list(q));
  }

  @Get('Users/:id')
  async get(@Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.scim.get(id));
  }

  @Post('Users')
  async create(@Body() body: any, @Res() res: Response) {
    const created = await this.scim.create(body);
    res.setHeader('Location', created.meta.location);
    this.send(res, created, 201);
  }

  @Put('Users/:id')
  async replace(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    this.send(res, await this.scim.replace(id, body));
  }

  @Patch('Users/:id')
  async patch(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    this.send(res, await this.scim.patch(id, body));
  }

  @Delete('Users/:id')
  async remove(@Param('id') id: string, @Res() res: Response) {
    await this.scim.remove(id);
    res.status(204).end();
  }
}

@SuperAdmin()
@Controller('admin/scim')
export class InstanceScimTokensController {
  constructor(private readonly scim: InstanceScimService) {}

  @Get('tokens')
  async list() {
    return { baseUrl: this.scim.baseUrl(), tokens: await this.scim.listTokens() };
  }

  @Post('tokens')
  create(@Body() body: { name: string; expiresAt?: string }, @Req() req: Request) {
    return this.scim.createToken(
      req['auth'].userId,
      body?.name,
      body?.expiresAt ? new Date(body.expiresAt) : undefined
    );
  }

  @Delete('tokens/:id')
  revoke(@Param('id') id: string, @Req() req: Request) {
    return this.scim.revokeToken(req['auth'].userId, id);
  }
}
