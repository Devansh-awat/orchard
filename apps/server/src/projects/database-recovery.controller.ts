import {
  Body,
  Controller,
  UseInterceptors,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request
} from '@nestjs/common';
import { Auth, RequireScope } from '../auth/decorators';
import { Idempotent } from '../idempotency/idempotency.interceptor';
import { DatabaseRecoveryService, type RestoreRequest } from './database-recovery.service';
import { StripOperationSecretsInterceptor } from './strip-operation-secrets.interceptor';

function who(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl
  };
}

@Auth()
@UseInterceptors(StripOperationSecretsInterceptor)
@Controller()
export class DatabaseRecoveryController {
  constructor(private readonly recovery: DatabaseRecoveryService) {}

  @Get('database-versions')
  versions() {
    return this.recovery.versions();
  }

  @Get('databases/:id/security')
  security(@Param('id') id: string, @Request() req) {
    return this.recovery.securityReport(id, req.user.sub, who(req));
  }

  @Get('projects/:id/database-security')
  projectSecurity(@Param('id') id: string, @Request() req) {
    return this.recovery.projectSecurity(id, req.user.sub, who(req));
  }

  @Post('databases/:id/minor-update')
  @Idempotent()
  minorUpdate(@Param('id') id: string, @Request() req) {
    return this.recovery.minorUpdate(id, req.user.sub, who(req));
  }

  @Post('databases/:id/upgrade')
  @Idempotent()
  upgrade(
    @Param('id') id: string,
    @Body() body: { major?: number; rehearse?: boolean },
    @Request() req
  ) {
    return this.recovery.upgrade(id, body ?? {}, req.user.sub, who(req));
  }

  @Get('databases/:id/recovery')
  recoveryWindow(@Param('id') id: string, @Request() req) {
    return this.recovery.recoveryWindow(id, req.user.sub, who(req));
  }

  @Get('databases/:id/diagnosis')
  diagnose(@Param('id') id: string, @Request() req) {
    return this.recovery.diagnose(id, req.user.sub, who(req));
  }

  @Get('databases/:id/activity')
  @RequireScope('deploy')
  activity(@Param('id') id: string, @Request() req) {
    return this.recovery.activity(id, req.user.sub, who(req));
  }

  @Post('databases/:id/fork')
  @Idempotent()
  fork(@Param('id') id: string, @Body() body: RestoreRequest, @Request() req) {
    return this.recovery.fork(id, body ?? {}, req.user.sub, who(req));
  }

  @Get('databases/:id/operations')
  listOperations(@Param('id') id: string, @Request() req) {
    return this.recovery.listOperations(id, req.user.sub, who(req));
  }

  @Get('database-operations/:opId')
  operation(@Param('opId') opId: string, @Query('wait') wait: string, @Request() req) {
    return this.recovery.operation(opId, req.user.sub, who(req), wait === '1' || wait === 'true');
  }

  @Post('database-operations/:opId/cancel')
  cancel(@Param('opId') opId: string, @Request() req) {
    return this.recovery.cancelOperation(opId, req.user.sub, who(req));
  }

  @Post('database-operations/:opId/undo')
  undo(@Param('opId') opId: string, @Request() req) {
    return this.recovery.undoRestore(opId, req.user.sub, who(req));
  }

  @Get('databases/:id/checkpoints')
  listCheckpoints(@Param('id') id: string, @Request() req) {
    return this.recovery.listCheckpoints(id, req.user.sub, who(req));
  }

  @Post('databases/:id/checkpoints')
  @Idempotent()
  createCheckpoint(@Param('id') id: string, @Body() body: { label?: string }, @Request() req) {
    return this.recovery.createCheckpoint(id, body?.label, req.user.sub, who(req));
  }

  @Post('checkpoints')
  @Idempotent()
  createCheckpoints(
    @Body() body: {
      databaseIds?: string[];
      projectId?: string;
      environmentId?: string;
      label?: string;
    },
    @Request() req
  ) {
    return this.recovery.createCheckpoints(body ?? {}, req.user.sub, who(req));
  }

  @Get('checkpoints/groups/:groupId')
  checkpointGroup(@Param('groupId') groupId: string, @Request() req) {
    return this.recovery.checkpointGroup(groupId, req.user.sub, who(req));
  }

  @Post('checkpoints/groups/:groupId/restore')
  restoreGroup(
    @Param('groupId') groupId: string,
    @Body() body: { mode?: 'in_place' | 'fork' },
    @Request() req
  ) {
    return this.recovery.restoreCheckpointGroup(groupId, body ?? {}, req.user.sub, who(req));
  }

  @Post('checkpoints/:id/restore')
  restoreCheckpoint(
    @Param('id') id: string,
    @Body() body: { mode?: 'in_place' | 'fork'; name?: string; environmentId?: string },
    @Request() req
  ) {
    return this.recovery.restoreCheckpoint(id, body ?? {}, req.user.sub, who(req));
  }

  @Delete('checkpoints/:id')
  hideCheckpoint(@Param('id') id: string, @Request() req) {
    return this.recovery.hideCheckpoint(id, req.user.sub, who(req));
  }

  @Get('databases/:id/restore-tests')
  listRestoreTests(@Param('id') id: string, @Request() req) {
    return this.recovery.listRestoreTests(id, req.user.sub, who(req));
  }

  @Post('databases/:id/restore-tests')
  runRestoreTest(@Param('id') id: string, @Request() req) {
    return this.recovery.runRestoreTest(id, req.user.sub, who(req));
  }

  @Patch('databases/:id/protection')
  updateProtection(
    @Param('id') id: string,
    @Body() body: {
      deletionProtection?: boolean;
      ddlCheckpoints?: boolean;
      restoreTests?: boolean;
    },
    @Request() req
  ) {
    return this.recovery.updateProtection(id, body ?? {}, req.user.sub, who(req));
  }

  @Get('databases/:id/pooler')
  getPooler(@Param('id') id: string, @Request() req) {
    return this.recovery.getPooler(id, req.user.sub, who(req));
  }

  @Put('databases/:id/pooler')
  setPooler(
    @Param('id') id: string,
    @Body()
    body: {
      enabled?: boolean;
      poolMode?: 'transaction' | 'session';
      instances?: number;
      defaultPoolSize?: number;
      maxClientConn?: number;
    },
    @Request() req
  ) {
    return this.recovery.setPooler(id, body ?? {}, req.user.sub, who(req));
  }

  @Get('projects/:id/deleted-databases')
  listDeleted(@Param('id') id: string, @Request() req) {
    return this.recovery.listDeleted({ projectId: id }, req.user.sub, who(req));
  }

  @Post('deleted-databases/:id/restore')
  @Idempotent()
  undelete(
    @Param('id') id: string,
    @Body() body: { name?: string; environmentId?: string },
    @Request() req
  ) {
    return this.recovery.undelete(id, body ?? {}, req.user.sub, who(req));
  }

  @Get('databases/:id/replication')
  replication(@Param('id') id: string, @Request() req) {
    return this.recovery.replication(id, req.user.sub, who(req));
  }

  @Patch('databases/:id/replication')
  setReplication(@Param('id') id: string, @Body() body: { mode?: string }, @Request() req) {
    return this.recovery.setReplication(id, body?.mode as any, req.user.sub, who(req));
  }

  @Get('databases/:id/users')
  listRoles(@Param('id') id: string, @Request() req) {
    return this.recovery.listRoles(id, req.user.sub, who(req));
  }

  @Post('databases/:id/users')
  @RequireScope('deploy')
  createRole(
    @Param('id') id: string,
    @Body() body: { name?: string; access?: 'read' | 'write' },
    @Request() req
  ) {
    return this.recovery.createRole(id, body ?? {}, req.user.sub, who(req));
  }

  @Delete('databases/:id/users/:name')
  deleteRole(@Param('id') id: string, @Param('name') name: string, @Request() req) {
    return this.recovery.deleteRole(id, name, req.user.sub, who(req));
  }
}
