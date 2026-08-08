import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { NodePoolsService, NodePoolInput } from './node-pools.service';
import { Auth } from '../auth/decorators';
import { UserspaceSchedulingGuard } from './userspace-scheduling.guard';

// Superadmin-only pool management. No @Auth()/@SuperAdmin() decorator, so the
// global SuperAdminGuard default-denies to superadmins (same convention as
// NodesController). Separate prefix from `admin/nodes` avoids the `nodes/:id`
// vs `nodes/pools` route-ordering trap.
@Controller('admin/node-pools')
export class NodePoolsController {
  constructor(private readonly pools: NodePoolsService) {}

  @Get()
  async list() {
    return this.pools.list();
  }

  @Post()
  async create(@Body() body: NodePoolInput) {
    return this.pools.create(body);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.pools.get(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: NodePoolInput) {
    return this.pools.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.pools.remove(id);
  }
}

// Tenant-facing read of the pools a superadmin marked userSelectable. Any
// authenticated user, but only when the instance opted into userspace
// scheduling (guard 404s otherwise).
@Auth()
@UseGuards(UserspaceSchedulingGuard)
@Controller('node-pools')
export class UserNodePoolsController {
  constructor(private readonly pools: NodePoolsService) {}

  @Get()
  async list() {
    return this.pools.listSelectable();
  }
}
