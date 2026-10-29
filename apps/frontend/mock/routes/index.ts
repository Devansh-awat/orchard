import type { MockContext } from '../plugin.ts';
import type { Router } from '../router.ts';
import { databaseRoutes } from './databases.ts';
import { deploymentRoutes } from './deployments.ts';
import { gitRoutes } from './git.ts';
import { jobRoutes } from './jobs.ts';
import { projectRoutes } from './projects.ts';
import { securityRoutes } from './security.ts';
import { settingsRoutes } from './settings.ts';
import { shellRoutes } from './shell.ts';

export function registerRoutes(router: Router, ctx: MockContext) {
	shellRoutes(router, ctx);
	deploymentRoutes(router, ctx);
	projectRoutes(router, ctx);
	databaseRoutes(router, ctx);
	jobRoutes(router, ctx);
	securityRoutes(router, ctx);
	settingsRoutes(router, ctx);
	gitRoutes(router, ctx);
}
