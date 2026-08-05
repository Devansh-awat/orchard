import {
  All,
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
import { ScimService } from './scim.service';
import { ScimError } from './scim-error';
import { parseScimQuery as parseQuery, parseScimSearchBody as parseSearchBody } from './scim-query';

const SCIM_CONTENT_TYPE = 'application/scim+json';

function groupsAreReadOnly(): never {
  throw ScimError(
    501,
    null,
    'Groups are a read-only projection of organization roles; manage roles in-app',
  );
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

  @Post('Users/.search')
  async searchUsers(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    this.send(res, await this.scim.listUsers(parseSearchBody(body), this.ctx(req)));
  }

  @Get('Users/:id')
  async getUser(@Param('id') id: string, @Req() req: Request, @Res() res: Response, @Query() q: Record<string, any>) {
    this.send(res, await this.scim.getUser(id, parseQuery(q), this.ctx(req)));
  }

  @Post('Users')
  async createUser(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const created: any = await this.scim.createUser(body, this.ctx(req));
    // RFC 7644 §3.1 wants the new resource's URI echoed in Location.
    if (created?.meta?.location) res.setHeader('Location', created.meta.location);
    this.send(res, created, 201);
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

  @Post('Groups/.search')
  async searchGroups(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    this.send(res, await this.scim.listGroups(parseSearchBody(body), this.ctx(req)));
  }

  @Get('Groups/:id')
  async getGroup(@Param('id') id: string, @Req() req: Request, @Res() res: Response, @Query() q: Record<string, any>) {
    this.send(res, await this.scim.getGroup(id, parseQuery(q), this.ctx(req)));
  }

  // Without these, group writes fell through to the global 404 handler and IdPs
  // got a non-SCIM body they couldn't parse. 501 is the RFC 7644 §3.12 code for
  // an operation the service provider doesn't implement.
  @Post('Groups')
  createGroup() {
    groupsAreReadOnly();
  }

  @Put('Groups/:id')
  replaceGroup() {
    groupsAreReadOnly();
  }

  @Patch('Groups/:id')
  patchGroup() {
    groupsAreReadOnly();
  }

  @Delete('Groups/:id')
  deleteGroup() {
    groupsAreReadOnly();
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

  // RFC 7644 §3.11: /Me is optional, and a provider that doesn't implement it
  // says so with a 501 rather than an unexplained 404. A SCIM bearer token
  // authenticates an org, not a person, so there's no "me" to resolve.
  @All('Me')
  me(): never {
    throw ScimError(501, null, '/Me is not supported; SCIM tokens authenticate an organization');
  }

  // Anything else under /scim/v2 would otherwise fall through to the global
  // handler and answer with a non-SCIM body. Declared last so it only catches
  // what nothing above matched.
  @All('*')
  notFound(@Req() req: Request): never {
    throw ScimError(404, null, `No SCIM endpoint at ${req.path}`);
  }
}
