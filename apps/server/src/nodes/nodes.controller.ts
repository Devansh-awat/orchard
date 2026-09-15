import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { NodesService } from './nodes.service';

@Controller('admin')
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get('nodes')
  async list() {
    return this.nodes.listNodes();
  }

  @Post('nodes/sync')
  async sync() {
    return this.nodes.syncFromCluster();
  }

  @Get('nodes/:id')
  async get(@Param('id') id: string) {
    return this.nodes.getNode(id);
  }

  @Patch('nodes/:id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      schedulable?: boolean;
      notes?: string | null;
      cpuCapacity?: string | null;
      memoryCapacity?: string | null;
    }
  ) {
    return this.nodes.updateNode(id, body);
  }

  @Patch('nodes/:id/taints')
  async setTaints(
    @Param('id') id: string,
    @Body() body: { taints: { key: string; value?: string | null; effect: string }[] }
  ) {
    return this.nodes.setNodeTaints(
      id,
      (body.taints ?? []).map((t) => ({ key: t.key, value: t.value ?? null, effect: t.effect }))
    );
  }

  @Patch('nodes/:id/labels')
  async setLabels(
    @Param('id') id: string,
    @Body() body: { labels: Record<string, string | null> }
  ) {
    return this.nodes.setNodeLabels(id, body.labels ?? {});
  }

  @Post('nodes/:id/assignments/:orgId')
  async upsertAssignment(
    @Param('id') id: string,
    @Param('orgId') orgId: string,
    @Body()
    body: {
      mode?: 'allow' | 'deny';
      cpuLimit?: string | null;
      memoryLimit?: string | null;
      maxServices?: number | null;
    }
  ) {
    return this.nodes.upsertAssignment(id, orgId, body);
  }

  @Delete('nodes/:id/assignments/:orgId')
  async deleteAssignment(@Param('id') id: string, @Param('orgId') orgId: string) {
    return this.nodes.deleteAssignment(id, orgId);
  }

  @Get('usage')
  async usage() {
    return this.nodes.getUsageSummary();
  }
}
