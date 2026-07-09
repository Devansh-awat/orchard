import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Request,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { ProjectAccessService } from '../projects/project-access.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { JobsService, JobInput, JobPatchInput, JobStepInput } from './jobs.service';
import { JobsOrchestratorService } from './jobs-orchestrator.service';

function userData(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl,
  };
}

@Auth()
@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly orchestrator: JobsOrchestratorService,
    private readonly projectAccess: ProjectAccessService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  private async assertJobView(jobId: string, req: any) {
    const job = await this.jobs.getJobOrThrow(jobId);
    const { user, access } = await this.projectAccess.assertProjectView(
      job.projectId,
      req.user.sub,
      userData(req),
    );
    return { job, user, access };
  }

  private async assertJobEdit(jobId: string, req: any, action: string) {
    const job = await this.jobs.getJobOrThrow(jobId);
    const { user, access } = await this.projectAccess.assertProjectEditAccess(
      job.projectId,
      req.user.sub,
      userData(req),
      action,
    );
    return { job, user, access };
  }

  private async assertRunView(runId: string, req: any) {
    const run = await this.jobs.getRunOrThrow(runId);
    const { user, access } = await this.projectAccess.assertProjectView(
      run.job.projectId,
      req.user.sub,
      userData(req),
    );
    return { run, user, access };
  }

  @Get('organizations/:orgId/jobs')
  async listOrgJobs(@Param('orgId') orgId: string, @Request() req) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, userData(req));
    if (!user) throw new NotFoundException('User not found');
    const filter = await this.projectAccess.buildProjectAccessFilter(user.id, orgId);
    if (filter === null) throw new NotFoundException('Organization not found');
    return this.jobs.listOrgJobs(orgId, filter);
  }

  @Get('projects/:projectId/jobs')
  async listProjectJobs(@Param('projectId') projectId: string, @Request() req) {
    await this.projectAccess.assertProjectView(projectId, req.user.sub, userData(req));
    return this.jobs.listProjectJobs(projectId);
  }

  @Post('projects/:projectId/jobs')
  async createJob(
    @Param('projectId') projectId: string,
    @Body() body: JobInput,
    @Request() req,
  ) {
    const { user } = await this.projectAccess.assertProjectEditAccess(
      projectId,
      req.user.sub,
      userData(req),
      'create jobs',
    );
    const job = await this.jobs.createJob(projectId, body ?? ({} as JobInput), user.id);
    await this.orchestrator.syncCronJob(job.id).catch(() => {});
    await this.audit.log({
      action: 'job.created',
      actorUserId: user.id,
      projectId,
      organizationId: job.organizationId,
      targetType: 'job',
      targetId: job.id,
      targetLabel: job.name,
    });
    return job;
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string, @Request() req) {
    await this.assertJobView(id, req);
    return this.jobs.getJobDetail(id);
  }

  @Patch('jobs/:id')
  async updateJob(@Param('id') id: string, @Body() body: JobPatchInput, @Request() req) {
    const { job, user } = await this.assertJobEdit(id, req, 'update jobs');
    const updated = await this.jobs.updateJob(id, body ?? {});
    await this.orchestrator.syncCronJob(id).catch(() => {});
    await this.audit.log({
      action: 'job.updated',
      actorUserId: user.id,
      projectId: job.projectId,
      organizationId: job.project.organizationId,
      targetType: 'job',
      targetId: id,
      targetLabel: updated.name,
    });
    return updated;
  }

  @Put('jobs/:id/steps')
  async replaceSteps(
    @Param('id') id: string,
    @Body() body: { steps: JobStepInput[] },
    @Request() req,
  ) {
    const { job, user } = await this.assertJobEdit(id, req, 'update jobs');
    const updated = await this.jobs.replaceSteps(id, body?.steps ?? []);
    await this.orchestrator.syncCronJob(id).catch(() => {});
    await this.audit.log({
      action: 'job.steps.updated',
      actorUserId: user.id,
      projectId: job.projectId,
      organizationId: job.project.organizationId,
      targetType: 'job',
      targetId: id,
      targetLabel: job.name,
    });
    return updated;
  }

  @Delete('jobs/:id')
  async deleteJob(@Param('id') id: string, @Request() req) {
    const { job, user } = await this.assertJobEdit(id, req, 'delete jobs');
    await this.orchestrator.teardownJob(job).catch(() => {});
    await this.jobs.deleteJob(id);
    await this.audit.log({
      action: 'job.deleted',
      actorUserId: user.id,
      projectId: job.projectId,
      organizationId: job.project.organizationId,
      targetType: 'job',
      targetId: id,
      targetLabel: job.name,
    });
    return { success: true };
  }

  @Post('jobs/:id/runs')
  async runNow(
    @Param('id') id: string,
    @Body() body: { allowConcurrent?: boolean } | undefined,
    @Request() req,
  ) {
    const { job, user } = await this.assertJobEdit(id, req, 'run jobs');
    const run = await this.orchestrator.triggerRun(job.id, {
      trigger: 'manual',
      triggeredBy: user.id,
      allowConcurrent: body?.allowConcurrent === true,
    });
    if (!run) {
      throw new ConflictException('A run is already in progress for this job');
    }
    await this.audit.log({
      action: 'job.run.triggered',
      actorUserId: user.id,
      projectId: job.projectId,
      organizationId: job.project.organizationId,
      targetType: 'job',
      targetId: id,
      targetLabel: `${job.name} #${run.number}`,
    });
    return run;
  }

  @Get('jobs/:id/runs')
  async listRuns(
    @Param('id') id: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Request() req,
  ) {
    await this.assertJobView(id, req);
    return this.jobs.listRuns(id, cursor || undefined, limit ? parseInt(limit, 10) || 25 : 25);
  }

  @Get('job-runs/:runId')
  async getRun(@Param('runId') runId: string, @Request() req) {
    await this.assertRunView(runId, req);
    return this.jobs.getRunDetail(runId);
  }

  @Post('job-runs/:runId/cancel')
  async cancelRun(@Param('runId') runId: string, @Request() req) {
    const { run, user } = await this.assertRunView(runId, req);
    await this.projectAccess.assertProjectEditAccess(
      run.job.projectId,
      req.user.sub,
      userData(req),
      'cancel job runs',
    );
    const result = await this.orchestrator.cancelRun(runId);
    await this.audit.log({
      action: 'job.run.cancelled',
      actorUserId: user.id,
      projectId: run.job.projectId,
      organizationId: run.job.project.organizationId,
      targetType: 'job',
      targetId: run.jobId,
      targetLabel: `${run.job.name} #${run.number}`,
    });
    return result;
  }

  @Get('job-runs/:runId/steps/:order/logs')
  async getStepLogs(
    @Param('runId') runId: string,
    @Param('order') order: string,
    @Request() req,
  ) {
    const { run } = await this.assertRunView(runId, req);
    const stepOrder = parseInt(order, 10);
    if (!Number.isFinite(stepOrder)) throw new NotFoundException('Step not found');
    const step = await this.jobs.getRunStepLogs(runId, stepOrder);
    if (step.status === 'running' && step.k8sJobName) {
      const live = await this.orchestrator
        .fetchLiveStepLogs(run.job.project.namespace, step.k8sJobName)
        .catch(() => null);
      if (live != null) {
        return { logs: live, truncated: false, live: true };
      }
    }
    return { logs: step.logs ?? '', truncated: step.logsTruncated, live: false };
  }
}
