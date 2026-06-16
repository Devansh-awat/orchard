import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { ScimAuthGuard, SCIM_ORG_KEY } from './scim-auth.guard';
import { ScimExceptionFilter } from './scim-exception.filter';
import { ScimService, ScimQuery } from './scim.service';

const SCIM_CONTENT_TYPE = 'application/scim+json';

function parseQuery(q: Record<string, any>): ScimQuery {
  return {
    filter: q.filter,
    attributes: q.attributes,
    excludedAttributes: q.excludedAttributes,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    startIndex: q.startIndex !== undefined ? Number(q.startIndex) : undefined,
    count: q.count !== undefined ? Number(q.count) : undefined,
  };
}

@Public()
@UseGuards(ScimAuthGuard)
@UseFilters(ScimExceptionFilter)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  private ctx(req: Request) {
    return { organizationId: req[SCIM_ORG_KEY] as string };
  }

  private send(res: Response, body: unknown, status = 200) {
    res.status(status).setHeader('Content-Type', SCIM_CONTENT_TYPE);
    res.send(JSON.stringify(body));
  }

  @Get('Users')
  async listUsers(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, any>) {
    this.send(res, await this.scim.listUsers(parseQuery(q), this.ctx(req)));
  }

  @Get('Users/:id')
  async getUser(@Param('id') id: string, @Req() req: Request, @Res() res: Response, @Query() q: Record<string, any>) {
    this.send(res, await this.scim.getUser(id, parseQuery(q), this.ctx(req)));
  }

  @Post('Users')
  async createUser(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    this.send(res, await this.scim.createUser(body, this.ctx(req)), 201);
  }

  @Put('Users/:id')
  async replaceUser(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    this.send(res, await this.scim.replaceUser(id, body, this.ctx(req)));
  }

  @Patch('Users/:id')
  async patchUser(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const result = await this.scim.patchUser(id, body, this.ctx(req));
    // SCIMMY returns undefined when a patch leaves nothing to represent.
    if (!result) return res.status(204).end();
    this.send(res, result);
  }

  @Delete('Users/:id')
  @HttpCode(204)
  async deleteUser(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    await this.scim.deleteUser(id, this.ctx(req));
    res.status(204).end();
  }

  @Get('Groups')
  async listGroups(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, any>) {
    this.send(res, await this.scim.listGroups(parseQuery(q), this.ctx(req)));
  }

  @Get('Groups/:id')
  async getGroup(@Param('id') id: string, @Req() req: Request, @Res() res: Response, @Query() q: Record<string, any>) {
    this.send(res, await this.scim.getGroup(id, parseQuery(q), this.ctx(req)));
  }

  @Get('ServiceProviderConfig')
  async serviceProviderConfig(@Res() res: Response) {
    this.send(res, await this.scim.serviceProviderConfig());
  }

  @Get('ResourceTypes')
  async resourceTypes(@Res() res: Response) {
    this.send(res, await this.scim.resourceTypes());
  }

  @Get('ResourceTypes/:id')
  async resourceType(@Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.scim.resourceTypes(id));
  }

  @Get('Schemas')
  async schemas(@Res() res: Response) {
    this.send(res, await this.scim.schemas());
  }

  @Get('Schemas/:id')
  async schema(@Param('id') id: string, @Res() res: Response) {
    this.send(res, await this.scim.schemas(id));
  }
}
