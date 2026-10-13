import { Inject, Injectable, Module } from '@nestjs/common';
import { Doors, type AuthDoor, type SettingsDoor } from '@orchard/graft-sdk/server';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from './analytics.service';
import { ApplyExecutorService, ApplyQueueService } from './apply.service';
import { AuditService } from './audit.service';
import { AuthorizationService } from './authorization.service';
import { GitHubService } from './github.service';
import { InstanceConfigService } from './instance-config.service';
import { SECTION_VALIDATORS } from './instance-config.sections';
import { InstanceSettingsService } from './instance-settings.service';
import { K8sCnpgService, KubernetesService } from './kubernetes.service';
import { LeaderElectionService } from './leader-election.service';
import { NotificationsService } from './notifications.service';
import { ProjectsService } from './projects.service';
import { RateLimitService, RedisThrottleService } from './rate-limit.service';
import { bindRequestContext } from './request-context';
import { SecretCryptoService } from './secret-crypto.service';
import { SessionsService } from './sessions.service';
import { UsersService } from './users.service';
import { VictoriaMetricsService } from './victoria-metrics.service';

@Injectable()
export class CoreBindings {
  constructor(@Inject(Doors.auth) auth: AuthDoor, @Inject(Doors.settings) settings: SettingsDoor) {
    bindRequestContext(auth);
    for (const [section, check] of SECTION_VALIDATORS) settings.validate(section, check);
  }
}

const SHIMS = [
  CoreBindings,
  PrismaService,
  AnalyticsService,
  ApplyQueueService,
  ApplyExecutorService,
  AuditService,
  AuthorizationService,
  GitHubService,
  InstanceConfigService,
  InstanceSettingsService,
  KubernetesService,
  K8sCnpgService,
  LeaderElectionService,
  NotificationsService,
  ProjectsService,
  RateLimitService,
  RedisThrottleService,
  SecretCryptoService,
  SessionsService,
  UsersService,
  VictoriaMetricsService
];

@Module({ providers: SHIMS, exports: SHIMS })
export class CoreModule {}
