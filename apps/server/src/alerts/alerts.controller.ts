import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request
} from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { MetricAlertsService, type AlertRuleInput } from './metric-alerts.service';

@Auth()
@Controller('organizations')
export class AlertsController {
  constructor(
    private readonly alerts: MetricAlertsService,
    private readonly usersService: UsersService,
    private readonly analytics: AnalyticsService,
    private readonly authz: AuthorizationService,
    private readonly projectAccess: ProjectAccessService
  ) {}

  private async requireMember(organizationId: string, req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
      username: req.user.username
    });
    if (!user) throw new NotFoundException('User not found');
    await this.authz.requireOrgMember(organizationId, user.id);
    return user;
  }

  private async requireNotificationsFeature(userId: string): Promise<void> {
    const enabled = await this.analytics.isFeatureEnabled('notifications', userId);
    if (!enabled) {
      throw new ForbiddenException(
        'Alerts are not enabled for your account. Enable the Notifications beta in Early Access Features.'
      );
    }
  }

  @Get(':id/metric-alerts/catalogue')
  async catalogue(@Param('id') organizationId: string, @Request() req) {
    await this.requireMember(organizationId, req);
    return this.alerts.catalogue();
  }

  @Get(':id/metric-alerts/states')
  async states(
    @Param('id') organizationId: string,
    @Query('deploymentId') deploymentId: string,
    @Request() req
  ) {
    await this.requireMember(organizationId, req);
    await this.projectAccess.assertDeploymentView(deploymentId ?? '', req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.alerts.statesFor(organizationId, deploymentId);
  }

  @Get(':id/metric-alerts')
  async list(
    @Param('id') organizationId: string,
    @Query('scopeType') scopeType: string | undefined,
    @Query('scopeId') scopeId: string | undefined,
    @Request() req
  ) {
    await this.requireMember(organizationId, req);
    return this.alerts.listRules(organizationId, scopeType, scopeId ?? null);
  }

  @Post(':id/metric-alerts')
  async create(@Param('id') organizationId: string, @Body() body: AlertRuleInput, @Request() req) {
    const user = await this.requireMember(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.alerts.createRule(organizationId, body ?? {}, user);
  }

  @Patch(':id/metric-alerts/:ruleId')
  async update(
    @Param('id') organizationId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: AlertRuleInput,
    @Request() req
  ) {
    const user = await this.requireMember(organizationId, req);
    await this.requireNotificationsFeature(user.id);
    return this.alerts.updateRule(organizationId, ruleId, body ?? {}, user);
  }

  @Delete(':id/metric-alerts/:ruleId')
  async remove(
    @Param('id') organizationId: string,
    @Param('ruleId') ruleId: string,
    @Request() req
  ) {
    const user = await this.requireMember(organizationId, req);
    return this.alerts.deleteRule(organizationId, ruleId, user);
  }
}
