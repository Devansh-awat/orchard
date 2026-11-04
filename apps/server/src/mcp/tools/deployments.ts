import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path } from '../client';
import { json } from './reply';

export function registerDeploymentTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'create_deployment',
    {
      description: `Create a new deployment from a Docker image in a project.
This also creates an internal ClusterIP service targeting the specified port.
If no port is specified, it defaults to 80. Make sure the port matches the port your container listens on.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
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
          .max(1000)
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
          ),
        environmentId: z
          .string()
          .optional()
          .describe(
            "Environment to create this in (from list_environments). Omit for the project's default environment."
          ),
        startCommand: z.string().optional().describe("Command to run instead of the image's CMD"),
        nodePoolId: z
          .string()
          .optional()
          .describe('Node pool to pin the deployment to. Omit to schedule anywhere.')
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
      imagePullPolicy,
      environmentId,
      startCommand,
      nodePoolId
    }) => {
      const deployment = await client.post(path`/projects/${projectId}/deployments`, {
        name,
        image,
        replicas: replicas ?? 1,
        ...(port && { port }),
        ...(env && { env }),
        ...(cpuRequestMilli != null && { cpuRequestMilli }),
        ...(memoryRequestBytes != null && { memoryRequestBytes }),
        ...(imagePullPolicy != null && { imagePullPolicy }),
        ...(environmentId && { environmentId }),
        ...(startCommand != null && { startCommand }),
        ...(nodePoolId && { nodePoolId })
      });
      return json(deployment);
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
      inputSchema: {}
    },
    async () => {
      const status = await client.get('/github/status');
      let hint =
        'GitHub account not linked. Ask the user to link it at /user/settings in the Orchard UI before deploying.';
      if (status.linked) {
        hint = status.installations?.length
          ? 'Use deploy_from_github with githubRepo="owner/repo" where owner matches one of the installation accountLogins. Use list_github_repos to see deployable repos.'
          : 'Account linked but no GitHub App installations visible. Ask the user to install the Orchard GitHub App on their account/org via the Orchard UI settings.';
      }
      return json({
        linked: status.linked,
        username: status.username,
        installations: status.installations,
        hint
      });
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
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        githubRepo: z
          .string()
          .describe('GitHub repository in owner/repo format (e.g. user/my-app)'),
        branch: z.string().optional().describe('Branch to deploy from (default: main)'),
        dockerfilePath: z
          .string()
          .optional()
          .describe('Path to Dockerfile relative to repo root (default: Dockerfile)'),
        target: z
          .string()
          .optional()
          .describe(
            'Stage to stop at in a multi-stage Dockerfile, as `docker build --target`. Omit to build the final stage, which is what a single-stage Dockerfile produces anyway. Stored on the deployment, so rebuilds keep it.'
          ),
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
          .max(1000)
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
          .describe('Memory request in bytes per pod. Subject to project/org/member quotas.'),
        environmentId: z
          .string()
          .optional()
          .describe(
            "Environment to deploy into (from list_environments). Omit for the project's default environment."
          )
      }
    },
    async ({
      projectId,
      name,
      githubRepo,
      branch,
      dockerfilePath,
      target,
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
      outputDirectory,
      environmentId
    }) => {
      const deployment = await client.post(path`/projects/${projectId}/deployments/from-github`, {
        ...(environmentId && { environmentId }),
        name,
        githubRepo,
        branch: branch ?? 'main',
        dockerfilePath,
        ...(target && { target }),
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
      return json(deployment);
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
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
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
        target: z
          .string()
          .optional()
          .describe(
            'Stage to stop at in a multi-stage Dockerfile, as `docker build --target`. Omit to build the final stage, which is what a single-stage Dockerfile produces anyway. Stored on the deployment, so rebuilds keep it.'
          ),
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
          .max(1000)
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
      target,
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

      const deployment = await client.post(path`/projects/${projectId}/deployments/from-github`, {
        name,
        repoUrl: `https://github.com/${owner}/${repo}`,
        branch: resolvedBranch,
        dockerfilePath,
        ...(target && { target }),
        buildFromRoot: buildFromRoot ?? false,
        ...(port && { port }),
        ...(env && { env }),
        ...(cpuRequestMilli != null && { cpuRequestMilli }),
        ...(memoryRequestBytes != null && { memoryRequestBytes })
      });
      return json(deployment);
    }
  );

  server.registerTool(
    'update_deployment_resources',
    {
      description: `Update CPU and memory requests for an existing deployment. The deployment will roll its pods to apply the new resources.
The API enforces project, organization, and per-member resource quotas — if the new values exceed your remaining allowance the call returns an error and nothing changes.
Pass null for either field to clear it and fall back to the project / org default.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
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
      const result = await client.patch(path`/deployments/${deploymentId}/resources`, body);
      return json(result);
    }
  );

  server.registerTool(
    'restart_deployment',
    {
      description: `Restart a deployment (rolling restart of all pods).
Whether this re-pulls the image depends on the deployment's pull policy. That policy is derived from the tag by default, so an app on a moving tag like :latest re-pulls and push-then-restart works. If someone pinned the policy to IfNotPresent, the node reuses its cached layer and a restart will not pick up a new push.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID to restart')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/restart`);
      return json(result);
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
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID to rebuild')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/rebuild`);
      return json(result);
    }
  );

  server.registerTool(
    'scale_deployment',
    {
      description: `Set how many replicas a deployment runs.

\`replicas: 0\` is the same thing as \`stop_deployment\` — it marks the deployment stopped and remembers the old count, so the next rebuild will not bring it back. Scaling to any positive number un-stops it. Prefer \`stop_deployment\` / \`start_deployment\` when the intent is "turn it off / back on"; they read clearly in the audit log and do not make you guess a count to restore.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        replicas: z.number().min(0).max(10).describe('Number of replicas (0 to pause, max 10)')
      }
    },
    async ({ deploymentId, replicas }) => {
      const result = await client.post(path`/deployments/${deploymentId}/scale`, { replicas });
      return json(result);
    }
  );

  server.registerTool(
    'stop_deployment',
    {
      description: `Take a deployment offline. Pods are drained and it stays down — a rebuild deploys it at zero replicas — until \`start_deployment\`.

The "turn it off" verb: it sets the deployment's \`stopped\` flag and leaves the replica count alone, so \`start_deployment\` brings it back at the size it was. Nothing is destroyed — build, env vars, domains, volumes and data all stay. (\`scale_deployment(0)\` reaches the same state; this is the clearer way to ask for it.)`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/stop`);
      return json(result);
    }
  );

  server.registerTool(
    'start_deployment',
    {
      description: `Bring a stopped deployment back online at its previous replica count (at least 1). The inverse of \`stop_deployment\`; a no-op on one that is already running.

Coming back re-checks quota, so a start can fail if the org filled up while the app was parked — scale it down first in that case.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/start`);
      return json(result);
    }
  );

  server.registerTool(
    'rename_deployment',
    {
      description: `Rename a deployment.

Only the display name changes. The Kubernetes workload name, service DNS, generated \`.orchard\` URL and any ingress hosts keep pointing where they did, so nothing that talks to this app has to be updated.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        name: z.string().describe('The new name')
      }
    },
    async ({ deploymentId, name }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/name`, { name });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_github_repo',
    {
      description: `Point a deployment at a different GitHub repository or branch without recreating it.

Takes effect on the next build, so follow with \`rebuild_deployment\` to make it live. Auto-deploy survives only if the GitHub App is installed on the new repo — otherwise it is switched off, silently, because pushes could never reach Orchard. Check \`get_auto_deploy_status\` afterwards.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        repoUrl: z
          .string()
          .describe('Repository, as owner/repo or a full https://github.com/... URL'),
        branch: z.string().describe('Branch to build from (e.g. main)'),
        dockerfilePath: z
          .string()
          .optional()
          .describe('Path to the Dockerfile in the new repo, if it moved')
      }
    },
    async ({ deploymentId, repoUrl, branch, dockerfilePath }) => {
      const result = await client.put(path`/deployments/${deploymentId}/github-repo`, {
        repoUrl,
        branch,
        ...(dockerfilePath !== undefined ? { dockerfilePath } : {})
      });
      return json(result);
    }
  );

  server.registerTool(
    'get_deployment_next_steps',
    {
      description: `Ask Orchard what this deployment has not been set up with yet: auto-deploy, a custom domain, explicit resource requests, notifications, a health check.

Returns a \`steps\` array of \`{ id, applicable, done }\` — act on the ones that are applicable and not done. Cheap, and the right follow-up after creating a deployment or when a user asks "what else do I need to do". \`applicable: false\` means the step cannot apply here (no repo linked, no public port, compose-managed), not that it passed.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.get(path`/deployments/${deploymentId}/next-steps`);
      return json(result);
    }
  );

  server.registerTool(
    'retry_deployment_apply',
    {
      description: `Requeue the Kubernetes applies that failed for this deployment, so a config change that saved but never reached the cluster gets another attempt.

Use it when \`get_deployment\` reports \`applyStatus: "failed"\` / a non-null \`applyError\`. It only touches work already marked failed, so the response's \`retried: 0\` means there was nothing stuck and the problem is elsewhere. It does not rebuild the image (\`rebuild_deployment\`) or bounce healthy pods (\`restart_deployment\`).`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/retry-apply`);
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_placement',
    {
      description: `Pin a deployment to a node pool, or clear the pin so it schedules anywhere.

Pools carry taints, so an app that needs particular hardware has to be placed into the matching pool to land there at all. Pass \`nodePoolId: null\` to unpin. Changing this rolls the pods.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        nodePoolId: z
          .guid()
          .nullable()
          .describe('Node pool UUID to pin to, or null to schedule anywhere')
      }
    },
    async ({ deploymentId, nodePoolId }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/placement`, {
        nodePoolId
      });
      return json(result);
    }
  );

  server.registerTool(
    'update_deployment_disruption_budget',
    {
      description: `Set how many replicas must stay available while Kubernetes drains a node.

Only meaningful above one replica: a budget equal to the replica count blocks voluntary evictions entirely and can wedge a node drain, so keep it below \`replicas\`.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        minAvailable: z
          .number()
          .int()
          .min(0)
          .describe('Minimum replicas that must stay up during a voluntary disruption')
      }
    },
    async ({ deploymentId, minAvailable }) => {
      const result = await client.patch(path`/deployments/${deploymentId}/disruption-budget`, {
        minAvailable
      });
      return json(result);
    }
  );

  server.registerTool(
    'rollback_deployment',
    {
      description:
        'Rollback a deployment to a previous image version. Use get_image_history to see available versions.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        imageHistoryId: z.guid().describe('The image history entry UUID to rollback to')
      }
    },
    async ({ deploymentId, imageHistoryId }) => {
      const result = await client.post(
        path`/deployments/${deploymentId}/rollback/${imageHistoryId}`
      );
      return json(result);
    }
  );

  server.registerTool(
    'cancel_build',
    {
      description: 'Cancel an in-progress build for a deployment',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/cancel`);
      return json(result);
    }
  );

  server.registerTool(
    'list_deploy_webhook_tokens',
    {
      description:
        'List the deploy webhook tokens on a deployment: label, when it was created, when it was last used. The token values themselves are hashed and never readable after creation, so a lost one has to be replaced.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const tokens = await client.get(path`/deployments/${deploymentId}/webhook-tokens`);
      return json(tokens);
    }
  );

  server.registerTool(
    'create_deploy_webhook_token',
    {
      description: `Mint a token that lets an outside system trigger a deploy over HTTP, for CI that builds elsewhere and pushes to Orchard.

The holder POSTs to \`/apiv1/webhooks/deploy\` with \`Authorization: Bearer <token>\`. On an image-source deployment they may send \`{ "image": "...", "tag": "..." }\` to roll a new image; on a GitHub-built deployment that is rejected and the POST just rebuilds from the repo.

**The plaintext token is in this response and nowhere else** — it is stored hashed, so hand it to the user now or it is gone. It inherits the creator's project access and is revoked automatically if they lose it.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        label: z
          .string()
          .optional()
          .describe('What this token is for, e.g. "github actions". Shows up in the audit log.')
      }
    },
    async ({ deploymentId, label }) => {
      const token = await client.post(path`/deployments/${deploymentId}/webhook-tokens`, {
        ...(label ? { label } : {})
      });
      return json(token);
    }
  );

  server.registerTool(
    'enable_auto_deploy',
    {
      description: `Enable auto-deploy for a deployment. When enabled, pushes to the configured branch automatically trigger a rebuild.

**The GitHub App has to be installed on the repository first.** Without it this call fails with a message naming the fix, because pushes never reach Orchard otherwise. Note that an App installed with "only select repositories" does not pick up a repository created after the install: it has to be added to the selection by hand.

Check with \`get_auto_deploy_status\` afterwards. If it reports \`deliverable: false\`, pushes will not build anything no matter what \`enabled\` says.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        branch: z.string().describe('The branch to auto-deploy from (e.g. main)'),
        paths: z
          .array(z.string())
          .max(1000)
          .optional()
          .describe(
            'Watch paths: glob patterns a push must touch to trigger a build (e.g. ["apps/web/**", "!**/*.md"]). Empty array deploys on every push. Omit to leave the current paths unchanged.'
          )
      }
    },
    async ({ deploymentId, branch, paths }) => {
      const result = await client.post(path`/deployments/${deploymentId}/auto-deploy/enable`, {
        branch,
        ...(paths !== undefined ? { paths } : {})
      });
      return json(result);
    }
  );

  server.registerTool(
    'get_auto_deploy_status',
    {
      description: `Whether pushes to this deployment's branch actually build anything.

\`enabled\` is what the user asked for. \`deliverable\` is what will happen: it is only true when the GitHub App is installed on the repo **and** this deployment is bound to that installation. When it is false, \`message\` says why and what to do.

Use this whenever auto-deploy looks like it is on but pushes are not producing builds. The usual cause is the App not being installed on that specific repository.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.get(path`/deployments/${deploymentId}/auto-deploy`);
      return json(result);
    }
  );

  server.registerTool(
    'disable_auto_deploy',
    {
      description: 'Disable auto-deploy for a deployment',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/auto-deploy/disable`);
      return json(result);
    }
  );
}
