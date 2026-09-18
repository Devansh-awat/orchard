import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient } from '../client';

export function registerDeploymentTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'create_deployment',
    {
      description: `Create a new deployment from a Docker image in a project.
This also creates an internal ClusterIP service targeting the specified port.
If no port is specified, it defaults to 80. Make sure the port matches the port your container listens on.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        image: z.string().describe('Docker image (e.g. nginx:latest, ghcr.io/user/app:v1)'),
        replicas: z.number().optional().describe('Number of replicas (default: 1)'),
        port: z
          .number()
          .optional()
          .describe(
            'Port the container listens on (default: 80). The created service will target this port.'
          ),
        env: z
          .array(
            z.object({
              key: z.string().describe('Environment variable name'),
              value: z.string().describe('Environment variable value')
            })
          )
          .optional()
          .describe('Environment variables to set on the deployment'),
        cpuRequestMilli: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "CPU request in millicores per pod (e.g. 500 = 0.5 CPU). Subject to project / org / per-member quotas — the API will reject the request if the resulting allocation exceeds the caller's limit."
          ),
        memoryRequestBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Memory request in bytes per pod (e.g. 536870912 = 512Mi). Subject to project / org / per-member quotas.'
          ),
        imagePullPolicy: z
          .enum(['Always', 'IfNotPresent'])
          .optional()
          .describe(
            'Leave unset: the policy is derived from the tag, so a moving tag like latest already gets Always. Only pass this to override that.'
          )
      }
    },
    async ({
      projectId,
      name,
      image,
      replicas,
      port,
      env,
      cpuRequestMilli,
      memoryRequestBytes,
      imagePullPolicy
    }) => {
      const deployment = await client.post(`/projects/${projectId}/deployments`, {
        name,
        image,
        replicas: replicas ?? 1,
        ...(port && { port }),
        ...(env && { env }),
        ...(cpuRequestMilli != null && { cpuRequestMilli }),
        ...(memoryRequestBytes != null && { memoryRequestBytes }),
        ...(imagePullPolicy != null && { imagePullPolicy })
      });
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    }
  );

  server.registerTool(
    'list_github_deploy_targets',
    {
      description: `List the GitHub accounts/orgs available for deploy_from_github. ALWAYS call this before deploy_from_github so the user can pick a target.
Returns:
- linked: whether the caller's GitHub account is linked to Orchard (required for deploy_from_github)
- username: the linked GitHub username (null if not linked)
- installations: GitHub accounts/orgs where the Orchard GitHub App is installed AND the caller has access (personal account + orgs)
If linked is false, tell the user to link their GitHub account at /user/settings in the Orchard UI.
If installations is empty, tell the user to install the Orchard GitHub App on their personal account or org. The install URL can be fetched server-side; ask the user to visit /user/settings.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {}
    },
    async () => {
      const status = await client.get('/github/status');
      let hint =
        'GitHub account not linked. Ask the user to link it at /user/settings in the Orchard UI before deploying.';
      if (status.linked) {
        hint = status.installations?.length
          ? 'Use deploy_from_github with githubRepo="owner/repo" where owner matches one of the installation accountLogins. Use list_github_app_repos to see deployable repos.'
          : 'Account linked but no GitHub App installations visible. Ask the user to install the Orchard GitHub App on their account/org via the Orchard UI settings.';
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                linked: status.linked,
                username: status.username,
                installations: status.installations,
                hint
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    'deploy_from_github',
    {
      description: `Deploy an application from a GitHub repository using owner/repo shorthand. This will build the Docker image from the repo and deploy it.
Before using this tool:
- Call list_github_deploy_targets to confirm the caller's GitHub account is linked AND that the owner you are about to deploy is one of the installed accounts/orgs
- If not linked or the owner has no Orchard GitHub App installation, tell the user to fix that via the Orchard UI (/user/settings) before retrying
- Ask the user about environment variables their app needs
- Ask if the app needs a database (use create_database tool)
- Ask if the app needs a public domain (use create_ingress tool after deployment)
- If the repo needs additional services like Redis, inform the user
- IMPORTANT: If no port is specified, the server will try to auto-detect the port from the Dockerfile's EXPOSE directive. If the Dockerfile has no EXPOSE directive, it defaults to port 80. If you are unsure about the port, check the Dockerfile first using get_repo_contents or ask the user what port their app listens on.
- If the Dockerfile copies files from the repo root (e.g. pnpm-workspace.yaml, package.json), set buildFromRoot to true
- If the repo has no Dockerfile, call detect_repo_config first: it reports every deployable app in the repo and the framework, commands and output directory detected for each. Pass buildType "railpack" plus the rootDirectory of the app the user wants, and leave the command fields unset unless detection got them wrong.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        githubRepo: z
          .string()
          .describe('GitHub repository in owner/repo format (e.g. user/my-app)'),
        branch: z.string().optional().describe('Branch to deploy from (default: main)'),
        dockerfilePath: z
          .string()
          .optional()
          .describe('Path to Dockerfile relative to repo root (default: Dockerfile)'),
        buildFromRoot: z
          .boolean()
          .optional()
          .describe('Whether to use repo root as build context (default: false)'),
        buildType: z
          .enum(['dockerfile', 'railpack'])
          .optional()
          .describe(
            '"dockerfile" builds the repo Dockerfile; "railpack" detects the language/framework and builds with no Dockerfile'
          ),
        rootDirectory: z
          .string()
          .optional()
          .describe(
            'Directory of the app inside the repo, e.g. apps/web. Only for railpack builds. Leave unset for a single-app repo'
          ),
        framework: z
          .string()
          .optional()
          .describe(
            'Framework label, e.g. vite or nextjs. Normally left unset so Railpack detects it'
          ),
        installCommand: z
          .string()
          .optional()
          .describe('Override the install step. Leave unset to use Railpack detection'),
        buildCommand: z
          .string()
          .optional()
          .describe('Override the build step. Leave unset to use Railpack detection'),
        startCommand: z
          .string()
          .optional()
          .describe(
            "Override the container start command. On a railpack build this is what Railpack bakes in; on a dockerfile build it runs instead of the image's CMD, like a command passed to docker run. Leave unset to use detection or the image's own"
          ),
        outputDirectory: z
          .string()
          .optional()
          .describe(
            'Directory of built static files, e.g. dist. Setting this makes the app a static site served by Caddy instead of a running server'
          ),
        port: z
          .number()
          .optional()
          .describe(
            'Port the application listens on. If not specified, auto-detected from Dockerfile EXPOSE directive, falling back to 80'
          ),
        env: z
          .array(
            z.object({
              key: z.string().describe('Environment variable name'),
              value: z.string().describe('Environment variable value')
            })
          )
          .optional()
          .describe('Environment variables to set on the deployment'),
        cpuRequestMilli: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CPU request in millicores per pod. Subject to project/org/member quotas.'),
        memoryRequestBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Memory request in bytes per pod. Subject to project/org/member quotas.')
      }
    },
    async ({
      projectId,
      name,
      githubRepo,
      branch,
      dockerfilePath,
      buildFromRoot,
      port,
      env,
      cpuRequestMilli,
      memoryRequestBytes,
      buildType,
      rootDirectory,
      framework,
      installCommand,
      buildCommand,
      startCommand,
      outputDirectory
    }) => {
      const deployment = await client.post(`/projects/${projectId}/deployments/from-github`, {
        name,
        githubRepo,
        branch: branch ?? 'main',
        dockerfilePath,
        buildFromRoot: buildFromRoot ?? false,
        ...(buildType && { buildType }),
        ...(rootDirectory && { rootDirectory }),
        ...(framework && { framework }),
        ...(installCommand && { installCommand }),
        ...(buildCommand && { buildCommand }),
        ...(startCommand && { startCommand }),
        ...(outputDirectory && { outputDirectory }),
        ...(port && { port }),
        ...(env && { env }),
        ...(cpuRequestMilli != null && { cpuRequestMilli }),
        ...(memoryRequestBytes != null && { memoryRequestBytes })
      });
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    }
  );

  server.registerTool(
    'deploy_from_github_url',
    {
      description: `Deploy an application by pasting a full GitHub repository URL. Use this when the user gives you a link (e.g. https://github.com/owner/repo or https://github.com/owner/repo/tree/branch) rather than an owner/repo pair.
Accepted URL shapes:
- https://github.com/<owner>/<repo>
- https://github.com/<owner>/<repo>.git
- https://github.com/<owner>/<repo>/tree/<branch>
- https://github.com/<owner>/<repo>/blob/<branch>/<path>
- git@github.com:<owner>/<repo>.git
The branch is auto-derived from /tree/<branch> or /blob/<branch> segments when present; otherwise it falls back to the branch parameter (default: main).
Before calling, you should still confirm with list_github_deploy_targets that the caller's account is linked and the repo owner has the Orchard GitHub App installed. The other guidance from deploy_from_github (env vars, databases, ingress, port detection, buildFromRoot) applies here too.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        repoUrl: z
          .string()
          .describe(
            'Full GitHub URL to the repo (https:// or git@). May include /tree/<branch> or /blob/<branch> segments — the branch will be parsed out.'
          ),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to deploy. Overrides any branch inferred from the URL. Defaults to main if neither is provided.'
          ),
        dockerfilePath: z
          .string()
          .optional()
          .describe('Path to Dockerfile relative to repo root (default: Dockerfile)'),
        buildFromRoot: z
          .boolean()
          .optional()
          .describe('Whether to use repo root as build context (default: false)'),
        port: z
          .number()
          .optional()
          .describe(
            'Port the application listens on. If not specified, auto-detected from Dockerfile EXPOSE directive, falling back to 80'
          ),
        env: z
          .array(
            z.object({
              key: z.string().describe('Environment variable name'),
              value: z.string().describe('Environment variable value')
            })
          )
          .optional()
          .describe('Environment variables to set on the deployment'),
        cpuRequestMilli: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CPU request in millicores per pod. Subject to project/org/member quotas.'),
        memoryRequestBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Memory request in bytes per pod. Subject to project/org/member quotas.')
      }
    },
    async ({
      projectId,
      name,
      repoUrl,
      branch,
      dockerfilePath,
      buildFromRoot,
      port,
      env,
      cpuRequestMilli,
      memoryRequestBytes
    }) => {
      const trimmed = repoUrl.trim();
      const httpsMatch = trimmed.match(
        /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+))?(?:\/.*)?$/i
      );
      const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
      const m = httpsMatch ?? sshMatch;
      if (!m) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Could not parse GitHub URL: ${repoUrl}. Expected something like https://github.com/owner/repo or https://github.com/owner/repo/tree/branch.`
            }
          ]
        };
      }
      const owner = m[1];
      const repo = m[2];
      const branchFromUrl = httpsMatch ? httpsMatch[3] : undefined;
      const resolvedBranch = branch ?? branchFromUrl ?? 'main';

      const deployment = await client.post(`/projects/${projectId}/deployments/from-github`, {
        name,
        repoUrl: `https://github.com/${owner}/${repo}`,
        branch: resolvedBranch,
        dockerfilePath,
        buildFromRoot: buildFromRoot ?? false,
        ...(port && { port }),
        ...(env && { env }),
        ...(cpuRequestMilli != null && { cpuRequestMilli }),
        ...(memoryRequestBytes != null && { memoryRequestBytes })
      });
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    }
  );

  server.registerTool(
    'update_deployment_resources',
    {
      description: `Update CPU and memory requests for an existing deployment. The deployment will roll its pods to apply the new resources.
The API enforces project, organization, and per-member resource quotas — if the new values exceed your remaining allowance the call returns an error and nothing changes.
Pass null for either field to clear it and fall back to the project / org default.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        cpuRequestMilli: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('New CPU request in millicores per pod, or null to clear.'),
        memoryRequestBytes: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('New memory request in bytes per pod, or null to clear.')
      }
    },
    async ({ deploymentId, cpuRequestMilli, memoryRequestBytes }) => {
      const body: Record<string, unknown> = {};
      if (cpuRequestMilli !== undefined) body.cpuRequestMilli = cpuRequestMilli;
      if (memoryRequestBytes !== undefined) body.memoryRequestBytes = memoryRequestBytes;
      const result = await client.patch(`/deployments/${deploymentId}/resources`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'restart_deployment',
    {
      description: `Restart a deployment (rolling restart of all pods).
Whether this re-pulls the image depends on the deployment's pull policy. That policy is derived from the tag by default, so an app on a moving tag like :latest re-pulls and push-then-restart works. If someone pinned the policy to IfNotPresent, the node reuses its cached layer and a restart will not pick up a new push.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to restart')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/restart`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'rebuild_deployment',
    {
      description: `Rebuild a deployment from source (triggers a new build from the GitHub repo).

Read the \`build\` field on the response before doing anything else:
- \`{ started: true, status: "building" }\` means a build is running now.
- \`{ started: false, status: "queued" }\` means it was accepted but every build slot is busy, or this deployment is already building. It starts on its own. **Do not call this again**: a second call supersedes the first and gets you no closer to the front. Poll \`get_deployment\` for the build status instead.

Everything else on the response is the deployment as it stands right now, so when a build is queued the build fields still describe the previous build. That is expected, not a failed call.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to rebuild')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/rebuild`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'scale_deployment',
    {
      description: 'Scale a deployment to a specific number of replicas',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        replicas: z.number().min(0).max(10).describe('Number of replicas (0 to pause, max 10)')
      }
    },
    async ({ deploymentId, replicas }) => {
      const result = await client.post(`/deployments/${deploymentId}/scale`, { replicas });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'rollback_deployment',
    {
      description:
        'Rollback a deployment to a previous image version. Use get_image_history to see available versions.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        imageHistoryId: z.string().describe('The image history entry UUID to rollback to')
      }
    },
    async ({ deploymentId, imageHistoryId }) => {
      const result = await client.post(`/deployments/${deploymentId}/rollback/${imageHistoryId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'cancel_build',
    {
      description: 'Cancel an in-progress build for a deployment',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/cancel`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'enable_auto_deploy',
    {
      description: `Enable auto-deploy for a deployment. When enabled, pushes to the configured branch automatically trigger a rebuild.

**The GitHub App has to be installed on the repository first.** Without it this call fails with a message naming the fix, because pushes never reach Orchard otherwise. Note that an App installed with "only select repositories" does not pick up a repository created after the install: it has to be added to the selection by hand.

Check with \`get_auto_deploy_status\` afterwards. If it reports \`deliverable: false\`, pushes will not build anything no matter what \`enabled\` says.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        branch: z.string().describe('The branch to auto-deploy from (e.g. main)'),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            'Watch paths: glob patterns a push must touch to trigger a build (e.g. ["apps/web/**", "!**/*.md"]). Empty array deploys on every push. Omit to leave the current paths unchanged.'
          )
      }
    },
    async ({ deploymentId, branch, paths }) => {
      const result = await client.post(`/deployments/${deploymentId}/auto-deploy/enable`, {
        branch,
        ...(paths !== undefined ? { paths } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'get_auto_deploy_status',
    {
      description: `Whether pushes to this deployment's branch actually build anything.

\`enabled\` is what the user asked for. \`deliverable\` is what will happen: it is only true when the GitHub App is installed on the repo **and** this deployment is bound to that installation. When it is false, \`message\` says why and what to do.

Use this whenever auto-deploy looks like it is on but pushes are not producing builds. The usual cause is the App not being installed on that specific repository.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.get(`/deployments/${deploymentId}/auto-deploy`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'disable_auto_deploy',
    {
      description: 'Disable auto-deploy for a deployment',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/auto-deploy/disable`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}
